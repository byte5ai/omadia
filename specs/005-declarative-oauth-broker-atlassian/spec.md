# Spec — Declarative kernel OAuth broker (descriptor engine) → Atlassian (Jira Cloud) integration

**Goal.** Finish spec 004's deferred layer 3 (the kernel OAuth broker, Task C),
but build it as a **declarative descriptor engine** rather than hardcoded
provider classes — so any future "connect X" plugin acquires standard
authorization-code credentials through pure manifest data, **without a bespoke
core PR**. Validate it end-to-end with a real, refresh-rotating IdP: a new
**`@omadia/integration-atlassian`** (Jira Cloud, read-only) + companion agent.

This is the broker analogue of what GitHub did for the flow toolkit: the
toolkit (layers 1+2) shipped validated by a real published plugin; the broker
(layer 3) was specced (FR-C1..C7) but deliberately shipped with **no real
consumer** (spec 004, D11 + FR-C6). This spec closes that asymmetry.

Two artifacts, shipped in lockstep:

1. **Core (PR against `byte5ai/omadia`)** — the declarative OAuth engine,
   `/oauth/start` + `/oauth/callback` broker routes, `ctx.oauthTokens`
   lazy-refresh accessor, and the `type:oauth` Connect-button UI.
2. **`byte5ai/omadia-atlassian` (new public repo, Hub-distributed)** —
   `@omadia/integration-atlassian` (holds the connection, publishes
   `atlassian.jira@1`) + `@omadia/agent-atlassian` (Jira read tools).

---

## Decision log (grilled 2026-06-16)

| # | Decision | Choice | Why |
|---|---|---|---|
| E1 | Broker shape | **Declarative descriptor engine** (core runs a generic RFC-6749 / PKCE / refresh dance from manifest data) — NOT concrete per-provider classes | User directive: future-proof. Spec 004's north star is "any future plugin gets the primitives without a bespoke core PR." A new IdP must not drag a core PR behind it. |
| E2 | Descriptor delivery | **Static manifest `oauth_providers` block** (inert data), NOT a runtime `ctx.oauth.registerProvider` hook | Maximal isolation: **no plugin code executes during the OAuth dance**. Descriptors are reviewable before install. "Computed descriptors" is a need no real IdP has — endpoints are constants. |
| E3 | Token isolation | The engine's `exchangeCode`/`refreshAccessToken` run **core-side**; refresh tokens never enter plugin code (preserves spec 004 FR-C4) | The whole reason to reject plugin-registered provider classes (which would see the refresh token in `provider.refreshAccessToken`). Declarative keeps the secret kernel-side. |
| E4 | Identity model | **One connection per (plugin, fieldKey)** — operator-authorized at install / re-connect, tokens in the plugin's vault namespace | "Connect your Atlassian site" is naturally operator-level. Matches the broker's specced single-token model (FR-C3). Per-user connections (each end-user links their own account) is the same extension Teams would need — **deferred**. |
| E5 | Provider creds (IdP app) | Plugin holds its own OAuth app: `client_id` (string) + `client_secret` (secret) setup fields, resolved at flow time via the requesting plugin's config/vault | Same integration-holds-app pattern as Odoo / the GitHub App. The descriptor names which fields carry the creds (`client_id_field`/`client_secret_field`). |
| E6 | Atlassian `cloud_id` | Resolved **integration-side** after first token (`GET accessible-resources`), persisted via `ctx.config.set('cloud_id'/'cloud_url')` | Keeps the broker IdP-generic. The Atlassian-specific resource discovery is the plugin's job, not the kernel's. |
| E7 | v1 product scope | **Jira read-only**: `jira_search` (JQL), `jira_get_issue`, `jira_my_issues`, `jira_list_projects`. Scopes `read:jira-work read:jira-user offline_access` | Fully exercises the broker (auth-code + PKCE + rotating-refresh + `cloud_id` discovery + a real authenticated call) with zero side-effect risk and the fastest live smoke. Mirrors GitHub v1's read-only posture. Confluence + write = fast-follow. |
| E8 | Plugin shape | **integration + agent**, mirroring GitHub. Integration publishes `atlassian.jira@1`; agent `requires` it and exposes the tools | Clean capability seam; swappable agent; known shape. |
| E9 | Compat / fallback | The Atlassian plugin **requires** the broker (no manual-paste fallback exists for OAuth). `compat.core` floored at the broker-shipping core | Unlike GitHub (which had a paste path), an OAuth-only integration has no degraded mode — if the core lacks the broker, the Connect action simply isn't offered. Documented + gated. |
| E10 | Repo home | New public repo **`byte5ai/omadia-atlassian`** | Org has standardized on one-repo-per-plugin (`omadia-google-workspace`, `omadia-channel-*`, `omadia-plugin-starter`). |
| E11 | Sequencing | Broker-in-core **first** (with the dormant Microsoft descriptor as a regression fixture + a stub-IdP integration test, no network), THEN the Atlassian plugin against it, THEN ship together | The engine is validated hermetically; only the final real-Jira smoke needs an external site. |
| E12 | MS descriptor | The dormant `MicrosoftGraphProvider` (spec 004 carry-over) collapses into a **descriptor fixture** proving the engine reproduces its exact authorize/token/refresh requests (incl. `{tenant_id}` URL interpolation) | Validates the engine covers a second real dialect for free; retires the bespoke class. No MS *consumer* ships here. |

---

## Architecture

```
        ┌──────────────────── CORE: declarative OAuth broker ─────────────────────┐
manifest│  oauth_providers: [{ id, authorize_url, token_url, token_auth_style,     │
declares│                      pkce, extra_authorize_params, client_id_field, … }] │
   ▼    │                                   │ (inert data — no plugin code runs)    │
type:oauth field  ──►  GET /api/v1/install/oauth/start   (operator-authed)          │
  provider: atlassian   • resolve descriptor by field.provider                      │
                        • resolve client_id/secret from plugin config+vault (E5)     │
                        • PKCE verifier → pendingFlows (server-side)                  │
                        • sign state (single-use, plugin-bound, 10-min)              │
                        • 302 → engine.buildAuthorizeUrl(descriptor, …)              │
                                   │                                                  │
                   GET /api/v1/install/oauth/callback   (public; state-verified)     │
                        • take pending flow (single-use)                             │
                        • engine.exchangeCode(descriptor, …)  ◄── refresh token       │
                        • persist {access,refresh,expiry,scope} → plugin vault ns     │     stays
                        • advance job (jobId) | store (pluginId re-connect)           │     core-side
                        • 302 → store page ?connected=ok|error                        │     (E3)
                                   │                                                  │
       ctx.oauthTokens.get(key) ──►  valid access token; lazy-refresh < 5-min margin │
                                      via engine.refreshAccessToken; rotate stored RT │
        └──────────────────────────────────┬───────────────────────────────────────┘
                                            │ validates the broker end-to-end
                       ┌────────────────────┴─────────────────────┐
                       │  @omadia/integration-atlassian            │
                       │   setup: client_id, client_secret(secret),│
                       │          connection (type:oauth)          │
                       │   oauth_providers: [atlassian descriptor]  │
                       │   on connect → resolve cloud_id (E6)       │
                       │   publishes  atlassian.jira@1 (REST client │
                       │     = ctx.oauthTokens + cloud_id + ctx.http│
                       │       → api.atlassian.com/ex/jira/{cid})   │
                       └────────────────────┬─────────────────────┘
                                            │ requires atlassian.jira@1
                       ┌────────────────────┴─────────────────────┐
                       │  @omadia/agent-atlassian                  │
                       │   jira_search · jira_get_issue ·          │
                       │   jira_my_issues · jira_list_projects     │
                       └───────────────────────────────────────────┘
```

---

## Descriptor schema (`oauth_providers[]`)

A top-level manifest array, sibling to `setup`. Validated at manifest-load like
any other field; older cores ignore unknown keys (additive).

| Key | Type | Notes |
|---|---|---|
| `id` | string | Referenced by a `type:oauth` field's `provider:`. |
| `authorize_url` | string | May contain `{field}` placeholders interpolated from the plugin's stored config (e.g. Microsoft's `…/{tenant_id}/oauth2/v2.0/authorize`). Atlassian's are static. |
| `token_url` | string | Same `{field}` interpolation. |
| `token_auth_style` | enum | How client creds + grant params reach `token_url`: `body_form` (urlencoded, creds in body — MS), `body_json` (JSON body — Atlassian), `basic` (HTTP Basic for creds, params urlencoded). |
| `pkce` | boolean | When true, engine generates verifier/challenge (S256) and threads them. Default true. |
| `extra_authorize_params` | map | Verbatim query params on the authorize URL (Atlassian: `audience`, `prompt`). |
| `client_id_field` | string | Setup-field key holding the OAuth client id. |
| `client_secret_field` | string | Setup-field key (secret type) holding the client secret. |

The engine parses standard token responses (`access_token`, `refresh_token`,
`expires_in`, `scope`). The dormant `MicrosoftGraphProvider` is expressed as a
`body_form` + `{tenant_id}` descriptor (E12).

---

## Phase F — Declarative OAuth engine (core)

- **FR-F1** — New `oauth/engine.ts`: `buildAuthorizeUrl`, `exchangeCode`,
  `refreshAccessToken` taking an `OAuthProviderDescriptor` + per-flow inputs.
  Honors `token_auth_style`, `pkce`, `extra_authorize_params`, `{field}`
  interpolation. Pure (inject `fetch` + `now` for tests).
- **FR-F2** — `manifestLoader` SHALL parse `oauth_providers[]` into the loaded
  manifest + validate descriptor shape (unknown `token_auth_style` → load
  error). Surfaced in `permissions_summary`/store-detail as an "Acquires OAuth
  credentials" signal (reuses the spec-004 `flows` chip vocabulary).
- **FR-F3** — Engine MUST NOT execute any plugin code; descriptors are data.
  Refresh tokens MUST stay within the engine + vault (never returned to plugin).
- **FR-F4** — Microsoft descriptor regression fixture: a unit test asserts the
  engine reproduces the exact authorize/token/refresh HTTP requests the retired
  `MicrosoftGraphProvider` produced (SC reproduction).

## Phase G — Broker routes + pending-flow (core)

- **FR-G1** — `GET /api/v1/install/oauth/start` (behind `requireAuth`), accepts
  `{jobId | pluginId, fieldKey}`. Resolves the `type:oauth` field's `provider`
  → descriptor from the plugin manifest; resolves `client_id`/`client_secret`
  from the plugin's stored config + vault (E5); creates a pending flow (PKCE
  verifier server-side); signs single-use, plugin-bound, 10-min state;
  302 → `engine.buildAuthorizeUrl`.
- **FR-G2** — `GET /api/v1/install/oauth/callback` (added to `publicPaths`).
  Verifies state, `take()`s the pending flow (single-use), `engine.exchangeCode`,
  persists `{access,refresh,expiry,scope}` to the plugin's vault namespace keyed
  by `fieldKey`, advances the install job (jobId path) or simply stores
  (pluginId re-connect path), 302 → store page with `?connected=ok|error`.
- **FR-G3** — `PendingFlow`/state claims extended to carry `pluginId` (not just
  `jobId`) so the store-detail re-connect path (FR-C5/C7) works without an
  install job. In-memory, 10-min TTL, single-process (spec 004 D9 limitation
  carried; Postgres upgrade path documented).
- **FR-G4** — User-deny / provider error → callback consumes the pending flow,
  stores nothing, redirects with a readable error (FR-C7).

## Phase H — `ctx.oauthTokens` + Connect UI (core)

- **FR-H1** — `ctx.oauthTokens` present when the manifest has ≥1 `type:oauth`
  field. `.get(fieldKey)` returns a currently-valid **access token**, lazily
  refreshing within a 5-min expiry margin via `engine.refreshAccessToken`
  (resolving client creds from config), rotating the stored refresh token.
  Refresh tokens NEVER returned. Typed errors: not-connected / refresh-failed.
- **FR-H2** — web-ui renders `type:oauth` fields as a **Connect** button
  ("Verbunden ✓" / "Nicht verbunden") in the install drawer (jobId path) and on
  the store-detail page (pluginId re-connect after revocation). Reuses the
  spec-004 `ctx.status` badge/banner for the "needs connection" hint.

## Phase I — `@omadia/integration-atlassian` (new repo)

- **FR-I1** — Manifest: `kind: integration`; setup fields `client_id` (string),
  `client_secret` (secret), `connection` (`type:oauth`, `provider: atlassian`,
  the E7 scopes); `oauth_providers: [atlassian descriptor]`;
  `permissions.secrets.runtime_write: true` (for `ctx.config.set('cloud_id')`);
  `network.outbound: [auth.atlassian.com, api.atlassian.com]`;
  `compat.core` floored at the broker-shipping core (E9).
- **FR-I2** — On first valid token (and on activate if connected), resolve
  `cloud_id`/`cloud_url` via `GET https://api.atlassian.com/oauth/token/accessible-resources`
  (Bearer from `ctx.oauthTokens.get('connection')`), persist via `ctx.config.set`.
  Report `ctx.status` (`needs_action` "Mit Atlassian verbinden" when unconnected;
  `ok`/clear when connected + `cloud_id` present).
- **FR-I3** — Publish `atlassian.jira@1`: a thin REST client = `ctx.oauthTokens`
  + `cloud_id` + `ctx.http`, hitting `api.atlassian.com/ex/jira/{cloud_id}/rest/api/3/…`.
  Read methods only: `search(jql)`, `getIssue(key)`, `myIssues()`, `listProjects()`.

## Phase J — `@omadia/agent-atlassian` (new repo)

- **FR-J1** — `kind: agent`; `requires: ["atlassian.jira@^1"]`; exposes
  `jira_search`, `jira_get_issue`, `jira_my_issues`, `jira_list_projects` as
  LLM tools over the consumed service. Read-only; no write tools (E7).
- **FR-J2** — Operator README: create an Atlassian 3LO app (developer.atlassian.com),
  copy client_id/secret, install integration, click Connect, install agent.

## Phase K — Validate + release

- **FR-K1** — Full middleware suite green; engine unit tests (MS fixture +
  Atlassian dialect), broker route integration tests against a **stub IdP**
  (no network) covering state audience-binding, single-use consume, refresh
  rotation, user-deny.
- **FR-K2** — Live smoke against a real Atlassian Cloud dev site + 3LO app:
  connect → callback persists tokens → `cloud_id` resolved → `jira_search`
  returns real issues → token transparently refreshes near expiry → re-connect
  from store-detail works.
- **FR-K3** — Land the core PR; publish `@omadia/integration-atlassian` 0.1.0 +
  `@omadia/agent-atlassian` 0.1.0 to the Hub in lockstep.

---

## Non-functional / security

- **Key isolation**: the OAuth engine runs **core-side**; client secrets live in
  the plugin vault namespace; refresh tokens never reach plugin code (E3, FR-F3,
  FR-H1). State-signing key stays kernel-held (spec 004).
- **No plugin code in the auth dance**: descriptors are inert manifest data
  (E2) — a buggy/hostile plugin cannot intercept the code or refresh token.
- **CSRF**: single-use, plugin-bound, 10-min state; pending-flow consumed on
  callback (FR-G2, FR-G4).
- **Public callback**: `/oauth/callback` is unauthenticated by the existing
  `publicPaths` design, self-secured by state verification — consistent with
  channel webhooks.
- **Operator visibility**: the `type:oauth` field + `oauth_providers` descriptor
  surface in store-detail before install (FR-F2).
- **Durability**: pending flows in-memory/single-process; mid-flow restart
  self-heals on re-click; Postgres-backed store documented as scale-out path.
- **Compat**: `oauth_providers` + the broker routes are additive. The Atlassian
  plugin honestly floors `compat.core` at the broker core (E9); no degraded mode
  for an OAuth-only integration.

## Success criteria

- **SC-F** — The engine reproduces the retired `MicrosoftGraphProvider`'s exact
  authorize/token/refresh requests from a descriptor (incl. `{tenant_id}`).
- **SC-G** — From the install drawer, an Atlassian `type:oauth` field renders a
  Connect button; completing authorize→callback stores tokens + advances the
  job; user-deny stores nothing and shows an error. State rejects a token signed
  for a different plugin and an expired token.
- **SC-H** — `ctx.oauthTokens.get('connection')` returns a valid access token and
  transparently refreshes (rotating the stored refresh token) one near expiry.
- **SC-I** — Installing the integration with only client_id/secret leaves status
  `needs_action`; Connect → consent → callback → `cloud_id` resolved → status
  clears. `atlassian.jira@1` `search` returns real issues.
- **SC-J** — The agent's `jira_my_issues` / `jira_search` answer a real
  "what are my open tickets?" turn end-to-end.
- **SC-K** — Re-connect from the store-detail page re-acquires a revoked
  credential without uninstall. Full suite green.

---

## Tasks (T21–T31)

### T21 — Descriptor schema + manifest parse
`oauth_providers[]` parsing/validation in `manifestLoader.ts`; types in
`api/admin-v1.ts` + web-ui mirror; permissions-summary signal. FR-F2.

### T22 — Declarative OAuth engine
`oauth/engine.ts` (`buildAuthorizeUrl`/`exchangeCode`/`refreshAccessToken`,
`token_auth_style`, `{field}` interpolation, PKCE). MS-descriptor regression
fixture. Retire `MicrosoftGraphProvider` class. FR-F1, F3, F4.

### T23 — pendingFlows + state: pluginId path
Extend `PendingFlow` + state claims with `pluginId`; keep `jobId` path. FR-G3.

### T24 — Broker routes: `/oauth/start` + `/oauth/callback`
`routes/install.ts` (+ `publicPaths`), descriptor resolution, client-cred chain,
token persistence, job-advance / re-connect, deny handling. FR-G1, G2, G4.

### T25 — `ctx.oauthTokens` lazy-refresh accessor
Gated on ≥1 `type:oauth` field; refresh-on-margin, RT rotation, no-leak, typed
errors. SDK type + boilerplate mirror. FR-H1.

### T26 — web-ui: `type:oauth` Connect button
Install drawer (jobId) + store-detail re-connect (pluginId); reuse status
badge. FR-H2.

### T27 — Core tests + PR
Engine units + stub-IdP broker integration tests (SC-F/G/H). Land core PR.
FR-K1.

### T28 — `byte5ai/omadia-atlassian` scaffold (new repo)
From `omadia-plugin-starter`. Workspace for both packages; ZIP build.

### T29 — integration-atlassian
Manifest (descriptor + oauth field + perms), `cloud_id` resolution, status
reporting, `atlassian.jira@1` REST client (read methods). FR-I1..I3.

### T30 — agent-atlassian + README
Four read tools over `atlassian.jira@1`; operator README (3LO app setup).
FR-J1, J2.

### T31 — Live smoke + release
Real Atlassian dev site (SC-I/J/K), then publish both packages 0.1.0. FR-K2, K3.
