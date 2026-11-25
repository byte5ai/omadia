# 0052 — Plugin HTTP routes: session by default, no self-declared "no auth", public only by an operator-granted prefix

## Status

Accepted

- **Date:** 2026-11-25
- **Deciders:** omadia maintainers (recorded retroactively from the code on main); epic #470 items C4/H1 (public paths), C6/G2/G3 (per-route auth and body), #1349, #1465; `teams-sso` from #1620
- **Supersedes:** —

## Context and Problem Statement

Plugins register Express routers through `ctx.routes.register`. Two things were open. A
router mounted outside `/api` (`/diagrams`, `/documents`, `/p/…`) had no session gate
unless it built one itself. And some plugin routes must be reachable without an omadia
session: webhook receivers, signed download links, Teams tabs. The kernel's session gate
runs before routing and sees only a URL, so an entry in the static list of public paths
says "this URL needs no session" and cannot say "and only this plugin may answer it".
This record is written retroactively; the decision is implemented on main.

How is a plugin route authenticated, and how does one become reachable without a session?

## Decision Drivers

- A plugin must not be able to switch authentication off by its own declaration.
- An unauthenticated prefix must belong to exactly one plugin and to nothing else.
- Every failure (no grants loaded, store down, plugin not active) must end in more
  authentication, never less.
- Webhook signatures need the request bytes as they arrived.

## Considered Options

- **A — Kernel-composed per-route stack; public reach through declared, exclusively
  owned, operator-granted prefixes on a terminating mount**
- **B — Let a plugin add entries to the static public-path list**
- **C — An `auth: 'none'` route option**
- **D — Plugins authenticate their own routes**

## Decision Outcome

Chosen option: **A**.

- **Four auth modes, fixed at registration** (`PluginRouteAuth` in
  `middleware/src/platform/pluginRouteRegistry.ts`):
  - `session` (default): the kernel composes the same `requireAuth` it mounts at `/api`
    into the route's own stack. CSRF posture is the kernel's (`SameSite=Lax` cookie).
  - `public`: no kernel authentication; served only through the public-path mount.
  - `custom`: as `public`, and the plugin asserts it authenticates every request itself
    (HMAC, bearer token).
  - `teams-sso`: as `public` in reach, but the kernel authenticates with the Teams SSO
    gate; no session fallback.
  There is no `none`. `public`, `custom`, `teams-sso` and `body: 'raw'` are registerable
  only beneath a prefix the plugin declared in `permissions.public_paths`.
- **The stack order per route is** disposed guard → auth → body parser → plugin router.
  The guard is first, so a deactivated plugin's prefix answers 404, not 401. The session
  resolver is a required constructor argument of the registry; a `teams-sso` registration
  without a wired gate throws.
- **Three gates for a public prefix:** declaration in the manifest (strict syntax: at
  least two segments, unreserved characters only, at most 16 entries, never under a
  kernel-reserved root such as `/api/v1/admin`), exclusive ownership claimed at activation
  (first activation wins; an overlapping second plugin fails to activate), and operator
  consent in `plugin_public_path_grants` (migration 0046). A declared, ungranted prefix is
  reserved but not served.
- **The mount terminates.** `createPublicPathMount` sits before the blanket
  `requireAuth`. A request under a granted prefix goes to the owning plugin's router; if
  that router does not handle it, the answer is 404 from the mount and the request never
  continues into the authenticated stack. Anything unknown calls `next()` into the normal
  gate. Only GET, HEAD, POST, PUT, PATCH, DELETE and OPTIONS pass.
- **Raw bodies are parsed before the global JSON parser** by `pluginRawBodyMount.ts`, for
  the longest live prefix covering the path and only if that winner is registered as
  `raw`. The default limit is 512 KB (`PLUGIN_RAW_BODY_LIMIT`), not the global 10 MB.
- **The static public-path list stays a kernel-owned literal.** No plugin id appears in it.

### Consequences

- 🟢 **Good:** A plugin route outside `/api` is behind the session unless an operator
  granted its prefix.
- 🟢 **Good:** A granted prefix is a closed world of one plugin; a router added later
  cannot answer inside it by accident.
- 🔴 **Bad:** A raw route buffers up to its limit for an anonymous caller before any
  authentication runs. The bound is the 512 KB default plus the declaration and grant
  that the prefix needs.
- 🔴 **Bad:** `custom` is an assertion the kernel cannot check; a plugin that forgets its
  signature check serves the granted prefix openly.
- 🔴 **Bad:** Express has no supported way to remove a router; a deactivated route stays
  in the stack as a 404 pass-through.
- 🔴 **Bad:** Public-path grants need a database; without one the consent endpoints
  answer 503 and nothing is public.
- ⚪ **Neutral:** A same-origin plugin UI rides the operator's cookie and can reach admin
  routes; that is the accepted exposure of the current iframe trust model and not a claim
  a manifest can make.

## Pros and Cons of the Options

### A — Composed stack and terminating grant mount

- 🟢 Fail-closed by position; ownership and consent are separate checks.
- 🔴 Three gates to explain to plugin authors and operators.

### B — Dynamic entries in the public-path list

- 🟢 Smallest change.
- 🔴 An exemption grants a URL, not a router: a subpath the plugin does not handle is
  answered by whoever is mounted behind it, without a session.

### C — `auth: 'none'`

- 🟢 Simple for authors.
- 🔴 A plugin declares its way out of authentication with no operator in the loop.

### D — Plugin-owned authentication

- 🟢 No kernel work.
- 🔴 The state before this decision: routers outside `/api` were unauthenticated unless
  they gated themselves.

## More Information

- Related: [ADR-0050](0050-plugin-database-access-declared-granted-and-kernel-run-migrations.md) (same
  consent route `PUT /installed/:id/grants`), [ADR-0016](0016-least-privilege-and-the-agent-envelope.md).
- Paths: `middleware/src/platform/pluginRouteRegistry.ts`, `publicPathGrants.ts`,
  `publicPathMount.ts`, `publicPathGrantStore.ts`, `pluginRawBodyMount.ts`;
  `middleware/src/auth/teamsSsoGate.ts`, `auth/publicPaths.ts`;
  `middleware/src/routes/runtimeGrants.ts`; `docs/security-architecture.md` (`/p/*`).
- Tests: `middleware/test/platform/pluginRouteAuthBody.test.ts` (guard-before-auth order,
  and the `terminate: false` counter-proof), `test/platform/teamsSsoRouteAuth.test.ts`,
  `test/publicPathGrants.test.ts`, `test/channelPublicPathClaim.test.ts`.
- Border: the Teams SSO gate itself belongs to the auth/channels domain.
