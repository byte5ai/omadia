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

## 9. API-key authentication (`@omadia/api-key-auth`, issues #438 / #439)

API keys are omadia's **second authentication method**, alongside the
human-bound `omadia_session` cookie. A server-to-server caller (the driving
use case is a Laravel/PHP integration) has no human behind it and no cookie
to present; it authenticates with a bearer key instead.

**Where the code lives.** All of it — mint/hash/verify, the key store, the
per-key rate limiter, the usage audit log, and the mountable `requireApiKey`
Express middleware — lives in the workspace package
`middleware/packages/harness-api-key-auth` (`@omadia/api-key-auth`). Issue
#438 shipped these inside the `@omadia/channel-api` plugin; issue #439 moved
them out so the kernel can use them too. The kernel must never import a
channel plugin, and a plugin cannot import kernel source, so a shared package
is the only home that lets both consume the same implementation. **There is
exactly one implementation of the credential** — a second one, however small,
is how a security-critical primitive quietly diverges.

**Mounting it.** Any Express route, kernel or plugin, can apply
`requireApiKey({ apiKeys, rateLimiter, auditLog, scope })`. It attaches an
`ApiKeyPrincipal` to `req.apiKey` and deliberately does **not** populate
`req.session`: a `SessionClaims` value means "a human logged in", and its
`role` is hard-typed `'admin'`, so synthesizing one for a machine would make
every downstream session-reading route silently treat a key as an operator.
A route has to opt in to machine callers by reading `req.apiKey`.

**Scopes (issue #439).** Every key carries a scope set — `<resource>:<action>`
strings, or the global `*`. `requireApiKey` answers `403 forbidden` when the
key lacks the scope the route declares. Matching is exact; there are no
prefix wildcards (`chat:*`), because a prefix matcher invites the "I thought
that didn't cover delete" mistake scopes exist to prevent. A key persisted
before scopes existed has **no** `scopes` field at all and is normalized to
`['chat:write']` — precisely the one capability it had when it was minted.
Defaulting such keys to `*` would also keep them working, and would silently
widen every existing key to whatever scoped surface lands next; that is a
privilege escalation delivered by an upgrade, so it is not what we do.

**Malformed persisted scopes deny, they do not default.** `normalizeScopes`
distinguishes *absent* from *malformed*. Absent (`scopes === undefined`, the
genuine pre-#439 record) → the legacy default above. Present but not an
array, or an array containing anything that is not a valid scope string
(`"memory:read"` stored as a bare string, `["Chat:Write"]` with the wrong
case, `[]`) → the **empty** scope set: the key still authenticates, and every
`hasScope` check on it fails closed, so it is authorized for nothing. This
matters because a malformed field is at least as likely to be a key an
operator deliberately restricted *away* from chat as it is to be corruption,
and falling back to a capability grant in that case hands the key exactly the
access the operator removed. Partially-valid arrays deny too rather than
silently narrowing to the valid subset — a record we cannot read faithfully
is a record we must not guess at. Each such case emits a
`[api-key-auth] malformed persisted scopes` warning so an operator can see
why a key stopped working.

**Session-gate exemption stays narrow.** `POST /api/public/v1/chat` is the
only API-key route exempted from the session middleware
(`middleware/src/auth/publicPaths.ts`). Mounting `requireApiKey` on a new
route requires adding that route to `publicPaths.ts` — add the narrowest
regex that covers the one route, never a prefix that also catches its
siblings. Note that omission from `publicPaths.ts` is *necessary but not
sufficient* for a plugin-contributed router to be authenticated; see the
admin-keys discussion immediately below for why. `POST /api/public/v1/chat`
remains the first and only ingress this app exposes that is **not** cookie-
or provider-JWT-gated.

**Key administration (`/api/public/v1/admin/keys`) — kernel-published
`ctx.operatorAuth`, in addition to the broad `/api` session gate.**
`middleware/src/index.ts` mounts `app.use('/api', requireAuth,
createChatRouter(...))` (the OB-106 hotfix) early in server boot, well
before `pluginRouteRegistry.mountAll(app)` runs later in the same boot
sequence. Express evaluates middleware in mount order for the whole `/api`
prefix regardless of which router ultimately answers a given path, so
`requireAuth` already runs in front of every `/api/*` request — including
plugin-mounted routes — unless that specific path is listed in
`middleware/src/auth/publicPaths.ts`'s exemption list. `/api/public/v1/admin/keys`
was never added to that list (only `.../chat` was, deliberately), so it was
already covered by this session gate, the same mechanism that protects
every other channel's non-exempted routes (see `publicPaths.ts`'s own doc
comment). An earlier revision of this document instead described the admin
routes as reachable by any anonymous caller; that was wrong — it read
`core.registerRouter` (`middleware/src/channels/routeRegistry.ts`, which
does only gate on the channel's active/inactive state) as the sole gate in
front of the router, without accounting for the broad `/api` mount that
Express already applies ahead of it. A minimal reproduction mirroring the
real mount order (real `createRequireAuth` + `publicPaths`, same mount
sequence as `index.ts`) confirms an anonymous request to
`/api/public/v1/admin/keys` gets `401 {code:'auth.missing'}` from that gate
before ever reaching the plugin router.

That coverage is real, but it depends on an *implicit* invariant: the
broad `/api` mount happening to run before this plugin's router is mounted,
and this path happening not to be added to `publicPaths.ts`. Either one is
easy to break by accident in a future refactor — reordering mounts, moving
this plugin behind a different prefix, or a well-meaning future PR adding
`/api/public/v1/admin` to the exemption list by pattern-matching too
broadly against the neighboring `/chat` entry. None of that would raise an
error; the admin surface would just quietly stop being gated. So the fix
below adds an *explicit* check inside the plugin itself, so the guarantee
travels with the router regardless of where or in what order it gets
mounted — and publishes a reusable accessor so future plugins that need an
admin surface don't have to rely on the same mount-order coincidence.

The real fix: `PluginContext` now exposes an optional `ctx.operatorAuth`
(`OperatorAuthAccessor`, `middleware/packages/plugin-api/src/pluginContext.ts`),
published by the kernel (`middleware/src/auth/operatorAuthAccessor.ts`) and
wired into every plugin-context factory
(`middleware/src/platform/pluginContext.ts`, threaded through
`ToolPluginRuntime`, `DynamicAgentRuntime`, and `DefaultChannelRegistry`).
`hasValidSession(cookieHeader)` reuses `evaluateSessionToken` — the EXACT
SAME session-verification logic `requireAuth` runs (same cookie name, same
signing key, same Entra-whitelist rule) — extracted into
`middleware/src/auth/requireAuth.ts` so there is exactly one code path that
decides session validity, never two that can drift apart.
`adminKeysRouter.ts` applies this as router-level middleware ahead of every
route: missing/invalid session → `401` (same `{code, message}` shape as
`requireAuth`); `ctx.operatorAuth` itself unavailable (an older host that
never wired it) → `503`, so the router **fails closed** rather than
silently mounting unauthenticated. See `adminKeysRouter.test.ts`'s
"operator-session auth" and "fails closed" test blocks for the coverage
that was missing before this fix.

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

**Rate limiting — fixed-window, per key, in-memory and per-process.** Each
key gets its own in-memory fixed-window counter (`rateLimiter.ts`, 60s
window, capacity = `rateLimitPerMinute` set at key-creation time). This
state lives in a single Node process's memory only — it is **not** shared
across multiple replicas/instances of this app, and a restart clears every
counter. If this app is ever run with more than one replica behind a load
balancer, each replica enforces the limit independently, so the effective
ceiling for a key is `rateLimitPerMinute × replica count`, not the
configured value. This is an accepted v1 trade-off, same bar as the
`TokenBucket` in `httpAccessor.ts` elsewhere in this codebase — "good enough
to stop a runaway caller", not a precise distributed quota. A shared/
distributed limiter (e.g. Redis-backed) was explicitly considered and
declined for v1; revisit only if multi-replica deployment of this app
becomes real.

**Revocation.** `POST /api/public/v1/admin/keys/:id/revoke` sets
`revokedAt` on the key's vault record (idempotent — revoking an
already-revoked key is a no-op that returns its unchanged view). `verify()`
skips any record with `revokedAt` set, so a revoked key starts failing
immediately on its very next call — no propagation delay, no cache to
invalidate.

**Usage audit.** Every call that gets *past key verification* — i.e. every
authenticated call, regardless of what happens next — is recorded as one
entry (`auditLog.ts`) with a status reflecting the real outcome: `ok`,
`rate_limited`, `forbidden` (scope check failed), `invalid_request`, or
`error` (the handler failed). `requireApiKey` records the outcomes it
produces itself; the route handler records its own via
`req.apiKey.audit(...)`, because only the handler knows whether the work
succeeded. Unauthenticated calls (missing/invalid/revoked key) are not
audited here — they never got the caller identity that makes an audit
entry meaningful.

**PII masking.** Chat turns from this ingress go through the exact same
`CoreApi.handleTurnStream` dispatch as every other channel (Teams,
Telegram, Omadia UI) — no second, parallel response path — so
privacy-guard's prompt masking and receipt behavior apply identically.

## 10. Operator surfaces vs. dev endpoints (`/api/dev`, issue #669)

Everything under `/api` is gated by one line in `middleware/src/index.ts`:

```ts
app.use('/api', requireAuth, createChatRouter({ … }));   // OB-106
```

It runs for **every** `/api/*` request, whichever router ultimately answers it.
The only way past it is an entry in `middleware/src/auth/publicPaths.ts`, and
every entry there is a surface that is unauthenticated until its own handler
says otherwise.

`/api/dev/*` used to hold such an entry, added whenever
`DEV_ENDPOINTS_ENABLED=true`. That made a single boolean the difference between
"operator only" and "anyone who knows the path" for:

- `GET /api/dev/graph/*` — raw knowledge-graph browsing (sessions, turns,
  neighbours, memories, plans)
- `/api/dev/memory/*` — the memory-store browser contributed by the memory plugin
- three `POST` routes that **triggered destructive knowledge-graph maintenance
  sweeps** (decay/rotation, GC eviction, access flush)

Confirmed empirically against a deployment under our control: uncredentialed
`GET`s returned `200` with real payloads.

**What holds now:**

1. There is no `/api/dev` entry in `publicPaths`, and `publicPaths()` takes no
   configuration — there is nothing left to flip. Every `/api/dev/*` request
   needs an operator session, exactly like `/api/v1/admin/*`.
2. The **operator** surfaces were never dev scaffolding and no longer live
   behind the flag. They mount unconditionally under the authenticated admin
   prefix (`middleware/src/routes/graphRouterMounts.ts`):

   | Surface | Path | Mounted when |
   |---|---|---|
   | KG lifecycle admin | `/api/v1/admin/kg-lifecycle` | `graphLifecycle@1` is published |
   | KG per-agent priorities | `/api/v1/admin/kg-priorities` | `agentPriorities@1` is published |
   | Plugin domains (read-only) | `/api/admin/domains` | always |

   `DEV_ENDPOINTS_ENABLED` is not an input to `mountKnowledgeGraphAdmin` — its
   deps type has no field to carry it, so the separation is a type, not a
   convention.
3. `DEV_ENDPOINTS_LOOPBACK_ONLY=true` (optional, default off) additionally
   refuses any `/api/dev` request that did not arrive over a loopback socket.
   It reads `req.socket.remoteAddress`, never `X-Forwarded-For` — `trust proxy`
   is on, so a guard on `req.ip` would be defeated by a header. Leave it off in
   containerised setups, where the Next.js server proxies from a container
   address.

**Operating guidance.** `DEV_ENDPOINTS_ENABLED` is dev scaffolding: leave it off
on deployed environments. It is no longer a security boundary on its own — but
it is still extra attack surface, and on any middleware build **older than this
change** it is unsafe on any internet-reachable deployment, with no mitigation
short of turning it off or blocking `/api/dev` upstream.

Tests: `middleware/test/devEndpoints/` (one no-credentials case per route,
including all three destructive `POST`s, plus the negative control that
restores the old allowlist entry and requires the surface to go open again).
`bash middleware/test/devEndpoints/mutation-check.sh` breaks each guard in
source and requires the suite to go red.

---

## 11. Reviewer checklist

Before merging a PR that touches credentials, prompts, or proxy routes:

- [ ] No new strings matching common token shapes
      (`AKIA…`, `ATATT…`, `sk-…`, `pk_…`, JWT-like).
- [ ] No new hostnames pointing at a specific tenant's infrastructure.
- [ ] Any new `setup.fields` of type `secret` are read through the vault
      adapter, not from `process.env` directly.
- [ ] Any new proxy route validates the response shape before returning it
      to the agent (defends against prompt injection from upstream).
- [ ] Any new sub-agent tool is scope-locked at construction time.
- [ ] No new entry in `auth/publicPaths.ts` unless the route authenticates
      itself, and then only the narrowest regex covering that one route (§10).
- [ ] No operator surface is mounted inside a `DEV_ENDPOINTS_ENABLED` block —
      operator routers belong under `/api/v1/admin/*` (§10).

---

*Last reviewed: 2026-08 (§10 added with issue #669).*
