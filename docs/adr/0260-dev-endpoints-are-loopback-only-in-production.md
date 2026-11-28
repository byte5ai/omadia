# 0260 — `/api/dev` is loopback-only under `NODE_ENV=production`

## Status

Accepted

- **Date:** 2026-11-27
- **Deciders:** Owner (wave 6 autonomy grant), W31 cluster lead
- **Supersedes:** — (refines [ADR-0062](0062-dev-endpoints-are-authenticated-scaffolding-operator-surfaces-never-depend-on-the-dev-flag.md): the loopback guard stops being purely opt-in)

## Context and Problem Statement

`/api/dev/graph` and the memory browser `/api/dev/memory` read memory without a viewer: with
`DEV_ENDPOINTS_ENABLED=true` any logged-in session reads every account's chat sessions,
context tiers and raw graph state. ADR-0062 left the loopback guard opt-in
(`DEV_ENDPOINTS_LOOPBACK_ONLY`, default `false`) because the compose dev stack reaches the
middleware from a container address. Nothing stopped a deployed instance with a copied `.env`
from exposing all accounts to each other (#2275), which breaks the owner decision of
2026-11-24 that private knowledge stays private. How do we make that fail closed without
breaking the compose dev flow?

## Decision Drivers

- Private memory must not be readable across accounts on any deployed instance.
- The compose dev stack (Next.js proxy from a bridge address) must keep working.
- No new setting; a deployment must not need to know about the problem to be safe.

## Considered Options

- **A — Force loopback-only for `/api/dev` whenever `NODE_ENV=production`.**
- **B — Refuse to boot when `DEV_ENDPOINTS_ENABLED=true` and the guard is off.**
- **C — Refuse `DEV_ENDPOINTS_ENABLED` entirely outside development.**

## Decision Outcome

Chosen option: **A**. `resolveDevLoopbackOnly` (`middleware/src/routes/graphRouterMounts.ts`)
returns `DEV_ENDPOINTS_LOOPBACK_ONLY || NODE_ENV === 'production'`; `src/index.ts` passes the
result to `mountDevLoopbackGuard`, which covers the whole `/api/dev` prefix (graph browser and
plugin routes such as the memory browser). The shipped image bakes `NODE_ENV=production`, so
every deployment is covered; the compose stack overrides it to `development` and keeps the
opt-in behaviour. A developer on a production build can still use `/api/dev` from the host
itself (loopback), e.g. through an SSH tunnel.

### Consequences

- 🟢 **Good:** A wrong flag on a deployed instance exposes nothing to remote sessions; the
  boot log says `loopback-only`.
- 🟢 **Good:** No crash loop from a copied `.env` (option B would take a running
  deployment down for a debugging flag).
- 🔴 **Bad:** A reverse proxy on the same host still makes every request look like loopback
  (unchanged from ADR-0062); deployments behind such a proxy must keep the flag off.
- ⚪ **Neutral:** `middleware/test/devEndpoints/` covers the production case with the real
  memory browser; the wiring test pins the resolver call in `src/index.ts`.

## Pros and Cons of the Options

### A — Force loopback under production

- 🟢 Fails closed without a new setting; dev compose unaffected.
- 🔴 Ties a security rule to `NODE_ENV`, which a deployment could override.

### B — Refuse to boot

- 🟢 Loudest signal.
- 🔴 Turns a debugging flag into an outage; same `NODE_ENV` question for the dev stack.

### C — Refuse the flag outside development

- 🟢 Simplest rule.
- 🔴 Removes the tunnelled-debugging path on a production build for no gain over A.

## More Information

Issue #2275; ADR-0062, ADR-0105, ADR-0183.
