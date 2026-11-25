# 0101 — API keys are a second authentication method: one shared implementation, a service identity per key, exact scopes

## Status

Accepted

- **Date:** 2026-11-25
- **Deciders:** omadia maintainers (recorded retroactively from the code on main); issues
  #438 and #439 (PR #549), lifecycle, scope catalog and admin audit #1327–#1329 (PR #1425).

## Context and Problem Statement

This record is retroactive: it documents a decision that is implemented on main.

A server-to-server caller (the driving case was a Laravel/PHP integration) has no human
behind it and no cookie to present. The first implementation of bearer keys lived inside the
`@omadia/channel-api` plugin; then the kernel needed the same check for the public MCP
endpoint, and the kernel must never import a channel plugin. What is an API key in omadia:
whose identity does it carry, what may it do, how is it stored, and where does the code live?

## Decision Drivers

- Exactly one implementation of a security primitive.
- A key must never be mistaken for a signed-in administrator.
- An upgrade must not widen what an existing key may do.
- A leaked database or vault must not yield usable keys.
- No new infrastructure for v1.

## Considered Options

- **A — A shared workspace package; each key is its own service identity with an exact
  scope set; hash-only storage in the vault.**
- **B — Keys act on behalf of a user** (delegation / impersonation).
- **C — A key synthesises an operator session** so existing routes just work.
- **D — Keep the implementation in the channel plugin and copy it into the kernel.**

## Decision Outcome

Chosen option: **A** (`middleware/packages/harness-api-key-auth`, `@omadia/api-key-auth`).

- **One package for kernel and plugins.** Mint, hash, verify, store, rate limiter, usage
  log and the `requireApiKey` Express middleware live there; `@omadia/channel-api` and the
  kernel's public MCP router both consume it.
- **Identity.** A key is `ChannelUserRef { kind: 'custom', id: 'key:<keyId>' }`. There is no
  "act on behalf of a user" surface. `requireApiKey` attaches `req.apiKey` and deliberately
  does not populate `req.session`; a route opts in to machine callers by reading `req.apiKey`.
- **Scopes.** `<resource>:<action>` strings or the global `*`; matching is exact, with no
  prefix wildcards. Built-ins are `chat:write`, `mcp:list`, `mcp:invoke` and well-formed
  `mcp:write:<tool>`; a bare `mcp:write` is rejected. Creation requires a known scope
  (`isKnownScope`); reading stays shape-only, so a key keeps a scope whose plugin was removed.
- **Legacy and malformed records.** A record with no `scopes` field is normalised to
  `['chat:write']`, the one capability it had when minted, never to `*`. A present but
  malformed field yields the empty set: the key authenticates and is authorised for nothing.
- **Storage.** Keys are `omk_` + 32 random bytes (base64url). The plaintext is returned once;
  only its unsalted SHA-256 is written, one vault entry per key in the plugin's namespace.
  `verify()` compares against every stored hash with `timingSafeEqual` and no early return.
- **Lifecycle.** `expiresAt` (at most 5 years ahead; unreadable → expired), revoke is
  immediate and idempotent, and `DELETE` removes only a revoked or expired record so
  deletion can never be an unaudited revoke. `isApiKeyActive` is the one predicate.
- **Rate limit.** A fixed 60 s window per key, capacity set at creation (default 60,
  1..6000 per minute), in memory and per process.
- **Audit.** Every call past key verification writes a usage entry with its real outcome
  (`ok`, `rate_limited`, `forbidden`, `invalid_request`, `error`), capped at 200 entries.
  Administration writes `api_key.create|revoke|delete` to `admin_audit` with the actor taken
  from the kernel's session evaluation (`ctx.operatorAuth`), under `PLUGIN_AUDIT_POLICY`.
- **Reachability.** A key-authenticated route needs the narrowest possible entry in
  `STATIC_PUBLIC_PATHS`; key administration stays behind the operator session.

### Consequences

- 🟢 **Good:** Every action traces to exactly one key; there is no impersonation boundary to
  police.
- 🟢 **Good:** A vault leak yields hashes of 256-bit random values, not keys.
- 🟢 **Good:** New scoped surfaces do not silently extend old keys.
- 🔴 **Bad:** The rate limit is per process: with N replicas the effective ceiling is
  N times the configured value, and a restart clears it. Accepted for v1.
- 🔴 **Bad:** A key cannot carry an end user's identity; per-user data rules cannot apply to
  an API caller beyond what the key's binding allows.
- 🔴 **Bad:** Verification walks every stored key; cost grows linearly with the key count.
- ⚪ **Neutral:** No key rotation primitive exists; rotation is create + revoke.

## Pros and Cons of the Options

### A — Shared package, service identity, exact scopes

- 🟢 One implementation, auditable identity, least privilege per key.
- 🔴 Routes must opt in explicitly; a scope vocabulary has to be maintained.

### B — Delegation

- 🟢 Per-user permissions apply to API calls.
- 🔴 A trust boundary to design and police; nothing needed it.

### C — Synthesised session

- 🟢 No route changes.
- 🔴 `SessionClaims.role` is `'admin'`: every session-reading route would treat a key as an
  operator.

### D — Two copies

- 🟢 No package to extract.
- 🔴 A second implementation of a credential check is how it quietly diverges.

## More Information

- Code: `middleware/packages/harness-api-key-auth/src/`,
  `middleware/packages/harness-channel-api/src/adminKeysRouter.ts`,
  `middleware/src/mcp/publicMcpRouter.ts`, `middleware/src/auth/operatorAuthAccessor.ts`.
- Tests: `middleware/test/auth/{requireApiKey,apiKeyScopes}.test.ts`,
  `middleware/test/channelApi/adminKeysRouter.test.ts`.
- Docs: `docs/security-architecture.md` §9.
- Related: [ADR-0105](0105-one-api-session-gate-and-a-closed-public-path-list.md),
  [ADR-0100](0100-admin-audit-trail-one-actor-rule.md),
  [ADR-0112](0112-secret-vault-and-credential-keychain-two-master-keys.md).
- Border: channels (`@omadia/channel-api`), MCP (public endpoint bindings).
