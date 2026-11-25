# 0038 — Conductor operator routes: a malformed id is a 400, an unknown id a 404

## Status

Accepted

- **Date:** 2026-11-23
- **Deciders:** Maintainers, from issue #1706; PR #2030. A deliberate divergence from the
  404-for-malformed precedent of #1318 and #1398, named in the PR for review.

## Context and Problem Statement

The id-bearing Conductor operator routes passed the caller's id to the store unchecked.
`conductor_runs.id`, `conductor_awaits.id`, `conductor_workflows.id` and
`conductor_webhook_subscriptions.id` are `uuid` columns, so `999` failed in Postgres with
`22P02 invalid input syntax for type uuid`, and each handler's catch-all copied that message
into a 500 body. Inbound endpoints had the opposite defect: `endpoint_id` is `TEXT`, the
`status` and `DELETE` writes matched zero rows and still answered `204`.

The repo already had `requireUuidParam` (`src/http/uuidParam.ts`). Admin users (#1318) and
routines (#1398) use it with `404`, on the reading that a malformed id is simply an unknown
one. Issue #1706 asked for `400` malformed / `404` unknown. Which contract do Conductor routes
follow?

## Decision Drivers

- No database error text in a response body.
- A success status only for a state change that happened.
- The admin UI already localises `conductor.invalid_input` and `conductor.not_found`.
- Existing callers of `requireUuidParam` must not change.

## Considered Options

- **A — Shape first, as `400 conductor.invalid_input`; existence second, as
  `404 conductor.not_found`.**
- **B — Follow the precedent: a malformed id is a 404 like an unknown one.**
- **C — Leave ids unchecked and map `22P02` in the catch-all.**

## Decision Outcome

Chosen option: **A**, for Conductor routes.

- **Router-level shape check.** `createConductorRouter` registers `router.param` for `runId`,
  `awaitId`, `workflowId` and `subscriptionId` with
  `requireUuidParam('conductor.invalid_input', 400)`. The store is never called with a
  malformed id. Slug-shaped template ids (`:id`, for example `notify-and-escalate`) are not
  guarded.
- **`requireUuidParam` takes the refusal status.** The default stays `404`, so admin users and
  routines answer byte for byte as before.
- **Existence before success.** Endpoint and subscription `status`, `DELETE` and `deliveries`
  check the row first and answer `404` for an unknown id instead of `204` or an empty list.
- **Not found is not closed.** `AwaitNotFoundError` separates "no such await" (404) from "this
  await is closed" (409). The approve/reject card path maps both to `already_resolved`.
- **Order.** The router-level guard runs before the `503 conductor.webhooks_unavailable`
  branch: on a host without Postgres a malformed id answers `400`, because it is unusable on
  every host.

### Consequences

- 🟢 **Good:** Callers can tell a typo from a deleted row; no Postgres message leaks.
- 🟢 **Good:** No more `204` for a row that does not exist.
- 🔴 **Bad:** Two conventions live side by side: Conductor answers 400 for a malformed id,
  admin users and routines 404. A new route has to pick one consciously.
- 🔴 **Bad:** A client that relied on `204` for an unknown endpoint now gets `404`.
- ⚪ **Neutral:** No migration, no URL change, no web-ui change.

## Pros and Cons of the Options

### A — 400 then 404

- 🟢 Matches the issue and the UI's existing error keys; more precise for API clients.
- 🔴 Diverges from the repo precedent.

### B — 404 for both

- 🟢 One convention across the repo; reveals less about id format.
- 🔴 Hides a client bug behind "not found".

### C — Map the database error

- 🟢 Smallest diff.
- 🔴 The store is still called with garbage; `TEXT` ids still answer success for nothing.

## More Information

- Code: `middleware/src/http/uuidParam.ts`, `createConductorRouter`.
- Tests: `middleware/test/conductorRouteIdGuards.test.ts` (every store method is a throwing
  proxy raising the real `22P02`), `conductorWebhookRoutes.test.ts`.
- Docs: `docs/middleware-agent-handoff.md` (uuid-guard rule and the Conductor params).
