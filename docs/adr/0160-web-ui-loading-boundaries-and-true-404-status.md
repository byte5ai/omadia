# 0160 — Loading boundaries sit per segment, so a not-found page answers 404

## Status

Accepted

- **Date:** 2026-11-25
- **Deciders:** omadia maintainers (recorded retroactively; rule from #1398, the dead-looking
  navigation finding OM-96, the plugin UI case #1454)

## Context and Problem Statement

This record is retroactive: it documents a routing rule that is implemented and tested on main.

In the Next.js App Router a `loading.tsx` (or a `<Suspense>` in a layout) flushes the response
shell, and with it the `200` status line, before the page below it runs. A page that then
calls `notFound()` serves the not-found UI with status 200. Without any boundary, a navigation
looks dead while the payload is in flight (OM-96). The web-ui needs both: feedback on every
navigation and a real 404 for an unknown routine, plugin or store entry. Where may a loading
boundary sit?

## Decision Drivers

- HTTP status is part of the contract; a 404 page under 200 misleads scripts and monitors.
- Every navigation shows progress.
- The rule must hold when someone adds a page, without a reviewer remembering it.

## Considered Options

- **A — No root boundary; one `loading.tsx` per segment; none in or above a page that calls
  `notFound()`; enforced by a test that reads the route tree.**
- **B — One root `app/loading.tsx` and accept 200 on not-found pages.**
- **C — No loading boundaries; pages block until data arrives.**

## Decision Outcome

Chosen option: **A**.

- **No root `app/loading.tsx`.** Each segment has its own `loading.tsx` that re-exports
  `app/_components/PageLoading`.
- **Never a boundary in or above a page that calls `notFound()`.** `notFound()` is called in
  the page file itself, not in a helper: the guard detects the literal call, and a delegated
  call loses both the guard and the status.
- **Index next to detail.** An index page that shares a segment with such a detail route lives
  in a route group (`store/(index)/page.tsx`, `(dashboard)/page.tsx`) so it can have a boundary
  of its own.
- **Every other page has a boundary in or above its directory.**
- **Enforced.** `web-ui/app/__tests__/loadingBoundaries.test.ts` walks the `app/` tree and
  fails on a re-added root boundary, a boundary above a `notFound()` page, or a page without
  any boundary.
- **Applied to the plugin UI host.** `app/plugin-ui/[pluginId]/page.tsx` validates the id, asks
  the middleware whether a bundle exists and calls `notFound()` itself. Only a 404 from the
  middleware means "absent"; a 5xx or a timeout lets the frame try, so an outage is not shown
  as a not-found page (`app/_lib/pluginUiBundle.ts`).

### Consequences

- 🟢 **Good:** An unknown id answers 404, with the not-found UI.
- 🟢 **Good:** The rule is checked from the file tree, not from a hand-kept list.
- 🔴 **Bad:** A detail page that can call `notFound()` has no loading boundary; its navigation
  shows no skeleton while the data loads.
- 🔴 **Bad:** One small `loading.tsx` per segment, and route groups that exist only to place a
  boundary.
- ⚪ **Neutral:** The guard reads source text. A page that reaches `notFound()` through a helper
  is outside it, which is why the rule forbids that.

## Pros and Cons of the Options

### A — Per-segment boundaries with a tree guard

- 🟢 Correct status and visible progress for all other pages.
- 🔴 More files; detail pages without a skeleton.

### B — Root boundary

- 🟢 One file, progress everywhere.
- 🔴 Every not-found page answers 200.

### C — No boundaries

- 🟢 Status always correct.
- 🔴 Navigations look dead (OM-96).

## More Information

- Rule: `web-ui/CLAUDE.md`, "Routing rule — loading boundaries vs. `notFound()` (#1398)".
- Code: `web-ui/app/_components/PageLoading.tsx`, `web-ui/app/not-found.tsx`,
  `web-ui/app/plugin-ui/[pluginId]/page.tsx`, `web-ui/app/_lib/pluginUiBundle.ts`.
- Test: `web-ui/app/__tests__/loadingBoundaries.test.ts`.
- Related: [ADR-0038](0038-conductor-routes-check-id-shape-400-then-404.md) (status codes on
  the API side), [ADR-0161](0161-web-ui-same-origin-front-and-runtime-proxy.md).
