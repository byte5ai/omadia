# 0062 — `/api/dev` is authenticated scaffolding; no operator surface depends on the dev flag

## Status

Accepted

- **Date:** 2026-11-25
- **Deciders:** omadia maintainers; issue #669, implemented in #674; loopback guard widened
  to the whole prefix in #1350. Recorded retroactively.
- **Supersedes:** —

## Context and Problem Statement

`DEV_ENDPOINTS_ENABLED=true` used to add `/api/dev` to the public paths. One boolean was then
the difference between "operator only" and "anyone who knows the path" for the raw
knowledge-graph browser, the memory browser and three `POST` routes that started destructive
knowledge-graph maintenance sweeps. Uncredentialed requests against a deployment under the
maintainers' control returned `200` with real data
(`docs/security-architecture.md` §10). The admin UI's lifecycle and priority pages needed the
same flag, so operators switched it on in production.

This record is retroactive. What may a dev flag decide, and where do operator surfaces live?

## Decision Drivers

- No configuration value may turn an authenticated surface into a public one.
- An operator feature must be reachable without enabling developer scaffolding.
- A guard on the client address must not be defeated by a header.
- Containerised dev setups must keep working.

## Considered Options

- **A — `/api/dev` always behind the operator session; operator surfaces moved to
  unconditional admin routers; an optional loopback-only guard on the socket address**
- **B — Keep the public exemption, require loopback always**
- **C — Remove the dev endpoints**

## Decision Outcome

Chosen option: **A**.

- **No exemption exists.** `publicPaths()` (`middleware/src/auth/publicPaths.ts`) takes no
  configuration and has no `/api/dev` entry. Every `/api/dev/*` request passes the one
  `app.use('/api', requireAuth, …)` line like `/api/v1/admin/*`.
- **The flag only mounts.** `DEV_ENDPOINTS_ENABLED` (default `false`) is read in one place,
  inside `mountDevGraph` (`graphRouterMounts.ts`), and decides whether the read-only graph
  browser `/api/dev/graph` exists. The memory browser `/api/dev/memory` is contributed by the
  memory plugin under its own setting `dev_memory_endpoints_enabled`.
- **Operator surfaces are not dev scaffolding.** KG lifecycle
  (`/api/v1/admin/kg-lifecycle`), per-agent priorities (`/api/v1/admin/kg-priorities`) and
  plugin domains (`/api/admin/domains`) mount through `mountKnowledgeGraphAdmin`, whose
  dependency type has no field that could carry the dev flag: the separation is a type, not a
  convention. The security checklist adds: "No operator surface is mounted inside a
  `DEV_ENDPOINTS_ENABLED` block".
- **Optional address gate.** `DEV_ENDPOINTS_LOOPBACK_ONLY=true` (default `false`) refuses with
  403 every `/api/dev` request that did not arrive over a loopback socket.
  `mountDevLoopbackGuard` sits on the whole prefix ahead of the graph browser and of plugin
  routes mounted later. It reads `req.socket.remoteAddress`, never `X-Forwarded-For` or
  `req.ip` (`auth/loopbackOnly.ts`).
- **Tests are part of the rule.** `middleware/test/devEndpoints/` holds one no-credentials
  case per route, a wiring test for the guard's position, the header-spoofing cases and a
  mutation check (`mutation-check.sh`).

### Consequences

- 🟢 **Good:** The worst a wrong dev flag does is expose raw graph state to a logged-in
  operator.
- 🟢 **Good:** Operators no longer enable scaffolding to reach product features.
- 🔴 **Bad:** With the flag on, any operator session reads raw knowledge-graph state (sessions,
  turns, memories, plans) through `/api/dev/graph`; omadia has no role below "operator" that
  could narrow this. The guidance is to keep the flag off on deployed environments.
- 🔴 **Bad:** The loopback guard is off by default, because a compose setup proxies through
  the Next.js server from a container address; behind a reverse proxy on the same host every
  request looks like loopback.
- 🔴 **Bad:** Plugin routes with `auth: 'public'` or `'custom'` are dispatched before the
  guard and are not covered; none lives under `/api/dev` today, and nothing but review keeps
  it that way.
- ⚪ **Neutral:** Middleware builds older than #674 are unsafe with the flag on any reachable
  host; the only mitigation there is to turn it off or block `/api/dev` upstream.

## Pros and Cons of the Options

### A — Always authenticated, surfaces split, optional loopback

- 🟢 Removes the class of error; dev flow intact.
- 🔴 Two flags and a plugin setting to understand.

### B — Public but loopback-only

- 🟢 No login for local tools.
- 🔴 Any proxy on the host turns "loopback" into "everyone"; containers break.

### C — Remove

- 🟢 No surface.
- 🔴 The graph viewer of the admin UI depends on the routes during development.

## More Information

- Related: [ADR-0040](0040-one-graph-read-boundary-per-turn.md) (turn reads; the dev browser
  is an operator read outside a turn). Border: auth-security (public paths, trusted proxies,
  session gate).
- Paths: `middleware/src/routes/{graphRouterMounts,devGraph,devGraphLifecycle}.ts`,
  `middleware/src/auth/{publicPaths,loopbackOnly}.ts`, `middleware/src/config.ts`
  (`DEV_ENDPOINTS_ENABLED`, `DEV_ENDPOINTS_LOOPBACK_ONLY`),
  `middleware/packages/harness-memory/src/devMemoryRouter.ts`,
  `docs/security-architecture.md` §10.
- Tests: `middleware/test/devEndpoints/{devEndpointsAuth.e2e,loopbackOnly,loopbackGuard.wiring}.test.ts`,
  `middleware/test/publicPaths.test.ts`, `middleware/test/sandboxListenGuard.test.ts` (#1024:
  the e2e suites may not skip themselves silently when a loopback listener is refused).
