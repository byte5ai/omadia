# 0105 — One session gate in front of `/api`; the list of public paths is closed and core-owned

## Status

Accepted

- **Date:** 2026-11-25
- **Deciders:** omadia maintainers (recorded retroactively from the code on main). The
  blanket gate is OB-106; the closed list and plugin grants come from epic #470 (C4, C6,
  C12); `/api/dev` from #669 (PR #674, #1409); plugin `'session'` routes from #1596 (PR #1608).

## Context and Problem Statement

This record is retroactive: it documents rules that are implemented on main.

The kernel serves core routers, routers that plugins mount at boot and at runtime, webhooks
that authenticate themselves, and operator tooling under `/api/dev`. Three incidents shaped
the rules: chat inference was reachable anonymously (OB-106), `DEV_ENDPOINTS_ENABLED=true`
turned graph browsing and three destructive maintenance sweeps into an anonymous surface
(#669), and a static `/p/<pluginId>/…` exemption let an HR plugin's absences page answer
anonymous requests (#1596). Where is authentication decided, and who may open a path?

## Decision Drivers

- A new route must be authenticated without its author doing anything.
- An unauthenticated surface must be visible in one place and reviewed as such.
- A plugin must not be able to declare itself out of authentication.
- No configuration flag may be the difference between "operator only" and "anyone".
- Every failure mode degrades to more authentication, never to less.

## Considered Options

- **A — One blanket gate on `/api`, a frozen core-owned exemption list, plugin public paths
  only through declaration + exclusive ownership + operator grant.**
- **B — Per-router authentication** (each router mounts its own guard).
- **C — A dynamic exemption list** that plugins or configuration can extend.

## Decision Outcome

Chosen option: **A**.

- **The blanket gate.** `app.use('/api', requireAuth, …)` in `middleware/src/index.ts` runs
  for every `/api/*` request, whichever router finally answers it. Routers mounted with
  their own `requireAuth` are defence in depth on top of it.
- **The exemption list is closed.** `STATIC_PUBLIC_PATHS` (`auth/publicPaths.ts`) holds only
  core-owned entries, each for a route that authenticates itself: `/api/v1/auth/*` and
  `/api/auth/*`, the install and MCP OAuth callbacks (signed single-use `state`), the Bot
  Framework messaging paths, the CIMD document, `POST /api/public/v1/chat` and the public
  MCP endpoint (API key). `publicPaths()` takes no configuration. Entries built from a
  shared path constant are matched exactly, never by a prefix that catches siblings.
  `test/auth/staticPublicPathsClosedSet.test.ts` pins the whole array.
- **Plugins do not extend the list.** A plugin declares a prefix in
  `permissions.public_paths`; the prefix is claimed exclusively at activation; it is served
  only while the operator's grant row exists (`platform/publicPathGrants.ts`). The granted
  mount sits before `requireAuth` and terminates: an unhandled subpath answers 404 and is
  never passed on into another router.
- **Plugin route auth modes.** `ctx.routes.register` takes `'session'` (default), `'public'`,
  `'custom'` or `'teams-sso'` (`platform/pluginRouteRegistry.ts`). `'session'` uses
  `createSessionGate`: the same evaluation as `requireAuth` with no public-path
  short-circuit, on every prefix including `/p/…`. The other three are registrable only
  beneath a declared public path. There is deliberately no `'none'`. The per-entry stack is
  `[disposed guard] → [auth] → [body parser] → [router]`, bound once at registration.
- **Dev endpoints are not a boundary.** `/api/dev/*` needs an operator session like
  `/api/v1/admin/*`. Operator surfaces mount unconditionally under the admin prefix
  (`routes/graphRouterMounts.ts`). `DEV_ENDPOINTS_LOOPBACK_ONLY=true` adds a guard that reads
  the socket peer, never a forwarded header.
- **Plugin admin routers carry their own check.** `ctx.operatorAuth` lets a plugin router
  verify the operator session itself and fail closed with 503 on a host that does not
  publish it, so the guarantee does not depend on mount order.

### Consequences

- 🟢 **Good:** "What is reachable without a session?" is answered by one array plus the
  grant table.
- 🟢 **Good:** A missing grant, a down store or an inactive plugin all end in a 401 or 404.
- 🔴 **Bad:** A route under `/api` that authenticates itself is dead (401) until core adds an
  entry; that happened to the multi-bot Teams messaging routes and the MCP OAuth callback.
- 🔴 **Bad:** Paths outside `/api` (`/p/…`, `/diagrams`, `/.well-known/…`) are not covered by
  the blanket gate; each mount must state its own gate.
- 🔴 **Bad:** The token-gated `/api/admin` router (`ADMIN_TOKEN`, `routes/admin.ts`) is
  mounted under `/api` and has no list entry, so the blanket gate runs in front of its
  bearer check.
- ⚪ **Neutral:** Channel plugins' own webhook routes (`ExpressRouteRegistry`) remain a
  separate mechanism and self-authenticate by contract.

## Pros and Cons of the Options

### A — Blanket gate, closed list, granted plugin paths

- 🟢 Safe by default; the exemption list is reviewable and test-pinned.
- 🔴 Core has to be touched for every new self-authenticating core route.

### B — Per-router guards

- 🟢 Each router is self-contained.
- 🔴 One forgotten guard is an anonymous route; that is how OB-106 and #1596 happened.

### C — Dynamic exemption list

- 🟢 No core change for a new public path.
- 🔴 `requireAuth` sees a URL, not the router that answers it: an exemption says "no session
  needed" without saying "and only this plugin may answer". A flag or a plugin then opens a
  surface nobody reviewed (#669).

## More Information

- Code: `middleware/src/auth/publicPaths.ts`, `auth/requireAuth.ts` (`createRequireAuth`,
  `createSessionGate`), `auth/operatorAuthAccessor.ts`, `auth/loopbackOnly.ts`,
  `platform/pluginRouteRegistry.ts`, `platform/publicPathGrants.ts`, `platform/publicPathClaim.ts`.
- Tests: `middleware/test/auth/staticPublicPathsClosedSet.test.ts`, `test/publicPaths.test.ts`,
  `test/publicPathGrants.test.ts`, `test/platform/pluginRouteAuthBody.test.ts`,
  `test/devEndpoints/`, `test/channelApi/adminKeysRouter.test.ts`.
- Docs: `docs/security-architecture.md` §5b, §9, §10.
- Related: ADR-0007 (CIMD entry), ADR-0014, [ADR-0114](0114-teams-sso-route-auth-verified-by-the-kernel.md),
  [ADR-0101](0101-api-keys-as-second-authentication-method.md),
  [ADR-0106](0106-operator-sessions-stateless-jwt-with-server-side-revocation.md).
- Border: plugin platform (public-path grants, route registry).
