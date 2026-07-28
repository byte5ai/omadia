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

## 7. Conductor generic webhooks (#437)

Inbound endpoints (`POST /api/hooks/:endpointId`) and outbound subscriptions
(HMAC-signed deliveries to an operator-supplied URL) are the one place in the
codebase with a deliberately **unauthenticated** ingress route, so the
security model is documented explicitly rather than left to code comments
alone.

**Secret placement.** Both an inbound endpoint's HMAC signing secret and an
outbound subscription's signing secret live in the secret vault under the
`core:conductor` namespace (`webhookEndpointStore.ts` /
`webhookSubscriptionStore.ts`) — the same metadata-in-Postgres /
secret-in-Vault split `DevGithubAppStore` uses for GitHub App credentials.
A secret is returned to the operator **exactly once**, on creation or
rotation; every list/get response omits it. Nothing under
`conductor_webhook_endpoints` or `conductor_webhook_subscriptions` ever
carries a secret column.

**Inbound route auth model.** `POST /api/hooks/:endpointId` has no
`requireAuth` — the per-endpoint HMAC signature (`X-Webhook-Signature:
sha256=<hex>`, computed over the raw, pre-`express.json()` request body) IS
the authentication, verified with a constant-time comparison
(`crypto.timingSafeEqual`). Two invariants the reviewer checklist below
should re-verify on any change to this route:

- **Identical 401 for unknown-endpoint vs. wrong-secret.** The signature is
  checked BEFORE anything about the endpoint (existence, enabled state) is
  trusted; an unknown `endpointId` and a known one with a wrong secret
  answer byte-for-byte the same `401 {"code":"webhook.bad_signature"}` — a
  caller can never use the response to probe which endpoint ids are real.
- **Always 2xx on noise.** Once the signature verifies and the delivery id
  is claimed, every remaining branch (disabled endpoint, malformed JSON, no
  subscribed workflow) answers `2xx`. Only a bad signature (401) or the
  per-endpoint rate limit (429) are non-2xx — so a well-behaved sender's
  retry policy never turns an ignorable delivery into a redelivery storm.

Delivery-id dedupe and the per-endpoint rolling-window rate limit are
enforced atomically in one transaction (`ConductorWebhookEndpointStore.claim`)
before any workflow run starts, closing the gap a correctly-signed sender
minting a fresh delivery id per call would otherwise open.

**Outbound SSRF guard.** Both outbound paths — the run-lifecycle dispatcher
(`webhookDispatcher.ts`) and the ad-hoc `webhook.post` Designer action
(`webhookPostAction.ts`) — route every request through
`conductor/webhookOutbound.ts`, which reuses the existing
`platform/ssrfGuard.ts` mechanism: a literal-IP precheck rejects a private /
loopback / link-local / cloud-metadata target before any DNS lookup, and the
actual request goes through a guarded `undici` `Agent` that re-checks the
resolved address to defend against DNS-rebinding between the precheck and
the connection. A subscription URL is also checked at creation time
(`assertOutboundUrlAllowed`), so an operator gets an immediate 400 rather
than only discovering the block on the first delivery attempt.

## 8. What lives in the vault

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
