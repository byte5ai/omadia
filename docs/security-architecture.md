# Security Architecture

This document describes the security-relevant design patterns the middleware
relies on. It is intentionally a *pattern* document — not a post-mortem and
not a credential inventory. Operational secrets, hostnames, and account
identifiers belong in your deployment vault, not in this repository.

If you operate Omadia, treat this file as the checklist your deployment must
satisfy.

---

## 1. Credentials never live in agent prompts or YAML config

LLM system prompts are read by every turn and are easy to leak through
debug logs, error traces, or transcripts. Therefore:

- **No bearer tokens, API keys, passwords, OAuth secrets, or database URLs
  in any `agent-config-*.yaml`, plugin `manifest.yaml`, or system prompt
  string.**
- Credentials are loaded from the secrets vault (`middleware/src/secrets/`)
  at boot, mounted into the runtime environment, and only ever passed
  through internal proxy routes.
- Plugin `setup.fields` of type `secret` are persisted encrypted at rest;
  they are never round-tripped to the LLM.

If you discover a credential in an agent prompt during review, treat it as
a leaked credential — rotate it before merging the fix.

## 2. Outbound calls go through internal proxy routes

Agents and sub-agents do not call third-party APIs directly. They call
middleware routes (`/api/internal/<provider>/<resource>`), and the middleware
attaches credentials server-side.

Benefits:

- The credential never enters the LLM context window.
- Rate-limiting, audit logging, and response-shape validation happen in one
  place.
- Rotating a credential is a vault update + middleware redeploy. The agent
  configuration does not change.

Pattern: thin proxy handler → typed client → upstream API. Document the
proxy contract next to the handler, not in the agent prompt.

## 3. Scope-locked sub-agent tools

Sub-agents operate with a `sessionScope` that constrains what they can read
or write. When a sub-agent is constructed it receives a *scoped* lookup
tool (`createGraphLookupTool(scope)`), not the raw graph client. The scope:

- Restricts entity reads to the current tenant / chat / user as appropriate.
- Prevents one user's sub-agent from reading another user's turn history.
- Survives prompt-injection attempts that ask the sub-agent to "use a
  different user id" — the tool simply does not accept an override.

## 4. Plugin install surface

Plugins are installed as signed ZIPs uploaded through the operator UI, not
discovered from public registries. This keeps the supply chain explicit:

- The operator chooses which artefacts run.
- A plugin manifest declares its `permissions` (memory, graph, network,
  filesystem). The runtime enforces the declaration.
- A plugin's `depends_on` is a soft contract, not an automatic install
  trigger.
- Optionally (issue #453), every ingested package — direct upload, hub
  install, Builder install — is statically scanned by an NVIDIA
  SkillSpector sidecar (`SKILLSPECTOR_URL`, deterministic `--no-llm` mode,
  no outbound calls; the scanner dependency is pinned to an exact upstream
  commit SHA — pin-bump procedure in the sidecar README). The scan is
  **advisory-only in v1**: it runs fire-and-forget after a successful
  ingest, its verdict (severity + findings, cached by ZIP sha256 + scanner
  version in `plugin_verdicts`, migration 0021) decorates the store detail
  page, and a scanner outage degrades to a `scan_failed` verdict — never a
  failed install. With `SKILLSPECTOR_URL` unset no scan is scheduled and no
  verdict row is written. The result pipeline is **fail-closed**: only
  SkillSpector's positively-verified report schema counts as a scan; an
  unrecognized schema is recorded as `scan_failed`, never as a
  `no_signals` all-clear. Entry-point coverage is fail-closed too: upload
  validation rejects a `lifecycle.entry` that resolves below
  `node_modules` or a hidden directory (`package.entry_unscannable` —
  the scanner's directory walk skips those, so the runtime would execute
  code the scan never saw), and as defense in depth the scanner
  force-includes the manifest's entry file in the scan payload when the
  walk skipped it, recording `scan_failed` when coverage cannot be
  guaranteed. Operator acknowledgements persist
  `ack_by`/`ack_at`/`ack_severity` for audit and are cleared automatically
  when a later re-scan worsens the verdict beyond the acked severity;
  turning the verdict into a hard install block is deferred until omadia
  has a role model (same policy gap as skill-verdict suppression, see
  `agentBuilder.ts`).

### Plugin-borne workflow templates (#478)

Plugins may contribute Conductor workflow templates, and the capability is
deliberately data-only:

- **Templates are data, never code.** A plugin declares TemplateManifest
  JSON files under `permissions.templates` (package-relative paths). That
  declaration is the entire capability: there is no runtime template API
  (`pluginContext.ts` gains no `ctx.templates`), nothing from these files is
  ever executed, and no registration endpoint exists — the only ingestion
  path is the plugin package itself.
- **Fail-closed install gate** (`src/plugins/pluginTemplates.ts`, invoked by
  `InstallService.configure()` before any persistent write): `.json` files
  only; the declared path must resolve inside the package root *after
  symlink unwrapping* (a confined-looking path whose file symlinks outside
  the package is rejected); the template id must be namespaced
  `plugin:<pluginId>:<name>` so a plugin can never shadow a bundled or
  user template id; the manifest must pass
  `checkTemplateManifest({ strict: true })` — undeclared concrete refs
  (agents/actions/roles/events/channels) are rejected as
  confusion/exfiltration vectors pointing at install-local entities — and
  every cron trigger value must pass `isValidCron`. Any violation fails the
  install with `install.template_invalid` and the per-template findings.
- **Read-only in the catalog.** Accepted manifests register as
  `source: 'plugin'` entries in the Conductor's composite template catalog;
  PUT/DELETE/submit/approve refuse them (403), and they are unregistered on
  uninstall. Boot re-registers templates of already-installed plugins
  fail-open per template (the fail-closed gate already ran at install time;
  a template problem must not brick boot).
- **Instantiation stays gated.** Plugin templates run through the same
  resolve/instantiate path as every other template, including live
  `KnownRefs` validation — a template referencing entities this install
  lacks fails visibly at mapping time, never silently.

## 5. Signed artefact URLs

User-visible artefacts (rendered diagrams, attachments, exports) are stored
in object storage and served via HMAC-signed URLs with a short TTL
(default: 3600s). The signing secret is a vault entry, not a config value.

URLs are scoped to a tenant prefix so that bucket browsing does not reveal
other tenants' keys.

## 6. Defence in depth for cached data

The Odoo / external-system response cache and the in-memory conversation
history are convenience layers, not security layers. They:

- Honour the same scope filters as the underlying graph queries.
- Do not extend a credential's lifetime beyond the originating request.
- Are flushed on process restart; they are not a substitute for persistence.

## 7. What lives in the vault

At a minimum, your deployment vault holds:

- Database connection string(s).
- Object-storage access key + secret.
- HMAC signing secret for diagram URLs.
- Upstream API tokens (one per integration).
- LLM provider key(s).
- Any tenant-/customer-specific secrets passed via `setup.fields` of type
  `secret`.

Nothing from this list should appear in `git grep` output of this repository.
If it does, that is a bug — file an issue and rotate.

## 8. Public API ingress (`@omadia/channel-api`, issue #438)

`POST /api/public/v1/chat` is the first ingress this app exposes that is
**not** cookie- or provider-JWT-gated: it authenticates its own callers with
a bearer API key, so it is explicitly exempted from the session middleware
(`middleware/src/auth/publicPaths.ts`, `${API_PREFIX}/chat` only — key
administration under `/api/public/v1/admin/keys` stays behind the normal
operator session cookie, same as every other admin surface).

**Credential model — per-key service identity.** Each API key *is* its own
identity, not a delegate for a human end-user: `ChannelUserRef{ kind:
'custom', id: 'key:<keyId>' }`. Every action traces to exactly one key;
there is no impersonation trust boundary to design or police, and no
"act on behalf of a user" surface in v1.

**Storage — vault-backed, hash-only-at-rest.** Keys are minted as
`omk_<32 random bytes, base64url>` (`apiKeyToken.ts`). The plaintext is
returned to the operator exactly once, at creation time, and is never
persisted; only its sha256 hex digest is written to this plugin's own
`ctx.secrets` vault namespace (`apiKeyStore.ts`, one vault entry per key —
no DB migration for v1). Hashing is deliberately unsalted: the key itself
is a 256-bit high-entropy random value, not a low-entropy human-chosen
secret, so there is no dictionary/rainbow-table surface for a salt to
defend against — the same reasoning applies to GitHub PATs and Stripe API
keys, which are also hashed unsalted.

**Verification — constant-time.** `verify()` walks every stored,
non-revoked key and compares each one's hash against the presented token's
hash with `crypto.timingSafeEqual`, deliberately without an early return on
the first match, so total work (and the timing signal) never depends on
which key, if any, matched.

**Rate limiting — fixed-window, per key.** Each key gets its own in-memory
fixed-window counter (`rateLimiter.ts`, 60s window, capacity =
`rateLimitPerMinute` set at key-creation time). In-memory and per-process:
a restart clears every counter, which is an accepted v1 trade-off (a burst
right after deploy is not the threat this defends against).

**Revocation.** `POST /api/public/v1/admin/keys/:id/revoke` sets
`revokedAt` on the key's vault record (idempotent — revoking an
already-revoked key is a no-op that returns its unchanged view). `verify()`
skips any record with `revokedAt` set, so a revoked key starts failing
immediately on its very next call — no propagation delay, no cache to
invalidate.

**Usage audit.** Every call that gets *past key verification* — i.e. every
authenticated call, regardless of what happens next — is recorded as one
entry (`auditLog.ts`) with a status reflecting the real outcome: `ok`,
`rate_limited`, `invalid_request`, or `error` (the orchestrator threw
mid-turn). Unauthenticated calls (missing/invalid/revoked key) are not
audited here — they never got the caller identity that makes an audit
entry meaningful.

**PII masking.** Chat turns from this ingress go through the exact same
`CoreApi.handleTurnStream` dispatch as every other channel (Teams,
Telegram, Omadia UI) — no second, parallel response path — so
privacy-guard's prompt masking and receipt behavior apply identically.

## 9. Reviewer checklist

Before merging a PR that touches credentials, prompts, or proxy routes:

- [ ] No new strings matching common token shapes
      (`AKIA…`, `ATATT…`, `sk-…`, `pk_…`, JWT-like).
- [ ] No new hostnames pointing at a specific tenant's infrastructure.
- [ ] Any new `setup.fields` of type `secret` are read through the vault
      adapter, not from `process.env` directly.
- [ ] Any new proxy route validates the response shape before returning it
      to the agent (defends against prompt injection from upstream).
- [ ] Any new sub-agent tool is scope-locked at construction time.

---

*Last reviewed: 2026-05.*
