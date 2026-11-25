# 0063 — The Dev Platform is a plugin in its own repository; core keeps generic extension points and no reference to it

## Status

Accepted

- **Date:** 2026-11-25
- **Deciders:** omadia maintainers; epic #470, plan and status in
  `specs/470-dev-platform-plugin/` (phases C1 to C14, among them #536, #539, #554, #555, #784,
  #793; the guard reached zero at C13 and was removed at C14 on 2026-08-21). Recorded
  retroactively.
- **Supersedes:** —

## Context and Problem Statement

The Dev Platform (coding jobs with runners, GitHub App, webhooks, four UI screens, a CLI) was
a core subsystem: about 49,100 lines in some 200 files, 276 hard-coded references in 18 zones,
its own tables, config keys, navigation entry and two public-path exemptions
(`specs/470-dev-platform-plugin/core-decoupling-checklist.md`). Every instance carried it,
used or not, and it could reach anything in core.

This record is retroactive. Where does a large optional subsystem live, and what does core owe
it?

## Decision Drivers

- With the plugin absent, the middleware boots with none of its code paths, tables or config
  and shows no navigation entry.
- With the plugin installed, nothing regresses.
- Whatever the plugin needs from core must be a mechanism any plugin can use
  ([ADR-0014](0014-plugins-are-only-the-delivery-form.md)).
- "Done" must be checkable while 49k lines move.

## Considered Options

- **A — Own repository, distributed as a plugin ZIP; remove every reference from core; build
  the missing extension points generically first**
- **B — Built-in package under `middleware/packages/`** (the plan's first draft)
- **C — Keep it in core behind a feature flag**

## Decision Outcome

Chosen option: **A**. The plugin lives at `byte5ai/omadia-dev-platform`.

- **Absent, not gated.** The repository contains no Dev Platform identifier: no import, route,
  config key, migration, i18n key or fixture token. What remains are plugin ids in comments
  and tests of generic mechanisms.
- **Missing extension points are built as platform features, not as special cases:**
  navigation contributed by plugins (`ctx.uiRoutes.registerNav`, `GET /api/v1/ui/navigation`,
  labels resolved on the server per locale, every field validated as untrusted input);
  manifest-declared, operator-consented public paths with exclusive prefix ownership
  (`platform/publicPathGrants.ts`); plugin-owned SQL migrations in the ZIP; disposal of a
  plugin's routes and provided services on deactivation; a plugin UI host
  ([ADR-0066](0066-plugin-ui-runs-in-a-same-origin-frame-with-a-fixed-style-vocabulary.md)); a golden
  snapshot of the `@omadia/plugin-api` declarations.
- **Dead couplings are deleted, not generalised.** The conductor's `dev_job` step port and the
  `ctx.devJobs` accessor never had a working provider; they were removed (#554, #555) instead
  of being turned into extension points (`dormant-capabilities.md`).
- **The plugin owns what core did for it:** its container images and their signing, its
  compose overlay, its runner protocol (`RUNNER_PROTOCOL_VERSION`) and its own API types.
- **What stays in core is generic.** `services/githubAppJwt.ts` (GitHub App JWT minting, also
  used by the Plugin Builder's issue reporting) stays, so that no reverse dependency crosses
  the repository boundary.
- **Wire paths were frozen during the move** (`/api/v1/dev-runner`,
  `/api/v1/admin/dev-platform`, `/api/webhooks/github`), because deployed runners call literal
  URLs.
- **A ratchet for the migration, removed afterwards.** `scripts/check-core-decoupling.mjs`
  counted identifier-shaped references per zone against a committed baseline (peak 3,448, 214
  at C10, 0 at C13). At zero it was deleted together with its CI job: bringing the subsystem
  back into core is now an ordinary architecture decision made in review.

### Consequences

- 🟢 **Good:** Instances that do not use the Dev Platform carry none of it.
- 🟢 **Good:** Six platform mechanisms exist that every other plugin can use; the weakest
  extension point of the platform (a real UI from a plugin) is closed.
- 🟢 **Good:** The subsystem has its own release cycle.
- 🔴 **Bad:** Three artefacts with separate versions (middleware, web-ui, plugin); a
  `compat.core` range in the manifest is now required, not optional.
- 🔴 **Bad:** No machine guard remains. The ratchet counted identifiers, never behaviour and
  never prose; the acceptance matrix (`acceptance.md` §2 and §3) is manual.
- 🔴 **Bad:** Stale artefacts of the in-core era remain: `docs/dev-platform/w0-manifest.json`
  and `w1-manifest.json` name a verify command over `middleware/test/devplatform/*.test.ts`,
  a directory that no longer exists.
- ⚪ **Neutral:** The rich chat card of a dev job rendered inside the core transcript had no
  generic equivalent when the plan was written (`plan.md` §4.3, H3).

## Pros and Cons of the Options

### A — Own repository, generic extension points

- 🟢 Clean boundary; the platform gains.
- 🔴 The largest change; version skew.

### B — Built-in package

- 🟢 Ships in one image, UI can stay compiled into web-ui.
- 🔴 Core's build still knows the subsystem; not uninstallable in the full sense.

### C — Feature flag

- 🟢 Cheapest.
- 🔴 The code, tables and exemptions stay in every instance; nothing forces clean seams.

## More Information

- Related: [ADR-0001](0001-plugin-distribution-via-signed-zip.md),
  [ADR-0014](0014-plugins-are-only-the-delivery-form.md) (the plugin's manifest kind moved to
  `system-module` with the 2042 release train),
  [ADR-0017](0017-model-gateway-and-execution-contexts.md) (`operatorJobs@1` and
  `modelPassthrough@1` for the plugin's coding jobs). Border: plugin-runtime (public path
  grants, plugin-api snapshot, migrations in ZIPs).
- Paths: `specs/470-dev-platform-plugin/{README,plan,implementation,acceptance,dormant-capabilities,core-decoupling-checklist}.md`,
  `middleware/src/platform/publicPathGrants.ts`, `middleware/src/services/githubAppJwt.ts`,
  `middleware/src/platform/modelPassthrough.ts`.
- Tests: `middleware/test/uiRouteCatalogPluginUiNav.test.ts`,
  `middleware/packages/plugin-api/test/apiSnapshot.test.ts`.
