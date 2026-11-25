# 0106 — Operator sessions: a stateless signed cookie, one evaluation function, revocation by a per-user version

## Status

Accepted

- **Date:** 2026-11-25
- **Deciders:** omadia maintainers (recorded retroactively from the code on main); renewal
  with an absolute cap in #965 (PR #1190), server-side revocation in PR #1262.

## Context and Problem Statement

This record is retroactive: it documents the session model that is implemented on main.

An operator signs in to the admin UI through a login provider and from then on every `/api`
request, every channel WebSocket and every plugin admin router has to decide whether that
sign-in still stands. A session store would answer this with a table read and a row delete.
omadia started with a stateless signed cookie, which no server can end early on its own, and
which a renewal chain could keep alive forever. How does a stateless session stay bounded,
revocable and identical for every consumer?

## Decision Drivers

- No session table: a kernel without Postgres must still verify a cookie.
- "Signed out" has to hold on every replica from the next request on.
- A stolen cookie must not live forever through renewals.
- Every consumer (HTTP, WebSocket, plugin routers, renewal) must reach the same verdict.
- A database blip must not sign every operator out.

## Considered Options

- **A — Stateless HS512 JWT cookie, a per-user integer `session_version` checked on every
  evaluation, explicit renewal with an absolute cap.**
- **B — Server-side session table** (opaque session id, row per sign-in).
- **C — Stateless JWT only**, short lifetime, no revocation.
- **D — JWT plus a "revoked before" timestamp or a `sid` denylist.**

## Decision Outcome

Chosen option: **A**.

- **The token.** `omadia_session` is an HS512 JWT (`auth/sessionJwt.ts`, issuer `omadia`),
  written by one helper (`auth/sessionCookie.ts`: `HttpOnly`, `SameSite=Lax`, `Path=/`,
  `Secure` from `requestIsSecure`, see [ADR-0111](0111-request-trust-boundary-named-proxies-and-declared-scheme.md)).
  One window is 4 h (`SESSION_WINDOW_S`). The signing key is 64 random bytes in the vault
  scope `core:auth`; rotating it is the global "sign everyone out" lever.
- **One evaluation function.** `evaluateSessionToken` (`auth/requireAuth.ts`) is the only code
  that decides validity: signature, the Entra e-mail whitelist gate, then the revocation
  guard. `requireAuth`, `createSessionGate` (plugin routes), `ctx.operatorAuth`, the channel
  WebSocket upgrade, open-socket re-checks, `GET /me` and `POST /renew` all call it.
- **Revocation is a version, not a timestamp.** `users.session_version` (auth migration
  `0003_users_session_version.sql`) is minted into the token as `sv`, together with `uid`
  (`users.id`) and `sid`. The session stands only while the row exists, is `active`, is the
  same row (`uid`) and still has that version. Sign-out, an admin password reset and
  disabling the account bump the version in the same statement as the change; deleting the
  row ends its sessions. There is no cache.
- **Renewal is explicit and capped.** `POST /api/v1/auth/renew` re-signs the claims with
  `auth_time` carried over; the new `exp` is `min(now + 4h, auth_time + cap)`, the cap is
  `AUTH_SESSION_MAX_LIFETIME_HOURS` (default 12, bounded 4..168). The principal is
  re-checked (provider active, row active, IdP re-validation for OIDC), fail closed, and the
  `auth.session_renew` audit row is written before the cookie is set.
- **Status mapping.** Missing, invalid or revoked → 401 (`auth.missing`, `auth.invalid`,
  `auth.revoked`); not whitelisted → 403; a revocation lookup that could not run → 503
  `auth.unavailable`. The UI bounces to `/login` only on 401.
- **CSRF posture.** `SameSite=Lax` and no token layer, for kernel and plugin routes alike
  (`platform/pluginRouteRegistry.ts`); no CORS middleware is mounted.
- **Open connections are bound to their session.** A channel socket closes at its token's
  `exp` and re-checks the session per frame (at most every `WS_SESSION_FRAME_RECHECK_MS`,
  default 5 s) and every 60 s while idle; a builder event stream re-checks per heartbeat.

### Consequences

- 🟢 **Good:** A sign-out, reset or disable holds on every replica from the next request on.
- 🟢 **Good:** One function decides; a new consumer cannot invent its own notion of "valid".
- 🟢 **Good:** Upgrading signs nobody out: tokens without `sv` read as version 0.
- 🔴 **Bad:** Sign-out is per user, not per device. A per-device sign-out would need a
  denylist keyed by `sid`, which nothing checks today.
- 🔴 **Bad:** Every authenticated request costs one point read on the shared pool.
- 🔴 **Bad:** Without Postgres there is no `users` table; the guard stays unattached and every
  signature-valid session passes (the boot log says so).
- ⚪ **Neutral:** Renewal runs only on an explicit click; silent activity-based renewal is
  deliberately not implemented.

## Pros and Cons of the Options

### A — JWT, per-user version, capped renewal

- 🟢 No session table; revocation is one indexed read on a row the kernel has anyway.
- 🔴 Coarser than a session table: all devices of a user end together.

### B — Session table

- 🟢 Per-device revocation and listing for free.
- 🔴 A second store to migrate, prune and keep consistent; no answer without Postgres.

### C — JWT only

- 🟢 No database read per request.
- 🔴 A copied cookie outlives a sign-out and a password reset.

### D — Timestamp marker or `sid` denylist

- 🟢 A denylist gives per-device sign-out.
- 🔴 `iat` has second granularity: a timestamp either refuses a sign-in made in the same
  second or accepts a token minted just before it. A denylist needs pruning.

## More Information

- Code: `middleware/src/auth/{requireAuth,sessionJwt,sessionCookie,sessionRevocation,sessionSigningKey}.ts`,
  `middleware/src/routes/{authRenew,authLogout}.ts`, `middleware/src/channels/webSocketRegistry.ts`.
- Tests: `middleware/test/auth/{sessionJwt,sessionRevocation,logoutRevokesSession,renewRoute,liveSocketRevocation}.test.ts`,
  `middleware/test/auth/userStoreSessionVersion.pg.test.ts`.
- Docs: `docs/security-architecture.md` §10b, §10d, §10k.
- Related: [ADR-0105](0105-one-api-session-gate-and-a-closed-public-path-list.md),
  [ADR-0100](0100-admin-audit-trail-one-actor-rule.md), ADR-0034 (no session-scoped Postgres state).
