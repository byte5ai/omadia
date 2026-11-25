# 0046 — Plugin activation fails soft: a circuit breaker, a typed failure code and one activation result

## Status

Accepted

- **Date:** 2026-11-25
- **Deciders:** omadia maintainers (recorded retroactively from the code on main); circuit breaker and auto-reset from S+8.5, truthful recording #1452, failure codes #1456, shared result #1497, dependents #1462, process-local reset #1860
- **Supersedes:** —

## Context and Problem Statement

Plugins run in the kernel's process and are activated at boot and whenever an operator
installs, updates or reconfigures one. An activation can fail for reasons the operator can
fix (a missing key, a missing grant), for reasons that pass (a database still starting) and
for reasons in the package. A failing plugin must not take the instance down or keep it in
a crash loop, and the operator needs to know which of these it is. The registry recorded
only the exception message, which is written for plugin authors, and the store showed it
to operators verbatim. This record is written retroactively; the decision is implemented
on main.

What happens when a plugin does not start, and what does the system say about it?

## Decision Drivers

- One broken plugin must not stop the boot of the others.
- A fixed cause must bring the plugin back without a reinstall.
- An operator action is one definitive event, not the first of several strikes.
- The reason must be a code a UI can translate, with the raw text kept as detail.
- A plugin that depends on another must not keep answering through a stale object.

## Considered Options

- **A — Soft-fail with a per-plugin circuit breaker, a classified failure code and one
  result shape for every activating write**
- **B — Fail the boot when an installed plugin does not activate**
- **C — Retry every plugin on every boot, without a latch**

## Decision Outcome

Chosen option: **A**.

- **An installed plugin has one of three states:** `active`, `inactive`, `errored`
  (`middleware/src/plugins/installedRegistry.ts`).
- **Circuit breaker.** A failed activation at boot is logged and counted; at
  `CIRCUIT_BREAKER_THRESHOLD` (3) consecutive failures the entry becomes `errored` and is
  skipped on later boots. A success resets the count. An activation an operator just
  triggered (install, config save, update) sets `errored` at once
  (`recordActivationFailure`).
- **Budgets.** A plugin's `activate()` has 10 s (`toolPluginRuntime.ts`). What a failed
  activation already registered (routes, nav entries, provided services) is rolled back,
  so a retry fails with the real error and not with a duplicate registration.
- **Auto-reset at boot** (`retryErroredPlugins` in `bootstrap.ts`), before plugins
  activate. An `errored` entry is tried again when its `manifest.yaml` is newer than the
  last failure, when every recorded `unresolved_requires` now has an active provider, when
  the last error looks transient (a fixed pattern of network and database-startup
  messages), when it was process-local (a duplicate service registration), or when its
  code is `database_not_available`.
- **Failure codes** (`ActivationErrorCode`, `activationFailure.ts`): `secret_missing`,
  `config_missing`, `capability_not_declared`, `network_not_permitted`,
  `permission_not_granted`, `dependency_unresolved`, `provider_conflict`,
  `target_unreachable`, `database_not_available`, `kind_retired`, `unknown`. The code is
  derived from the error object's `name`, typed fields and errno, never from the message,
  and by `name` rather than `instanceof` because a plugin may bundle its own copy of
  plugin-api. The raw message stays as `last_activation_error`, bounded to 500 characters.
  A missing code reads as `unknown`, never as "fine".
- **One result shape.** Every write that (re)activates a plugin answers with
  `PluginActivationResult` (`activationResultOf`): the state, the code and the missing
  grants. Absence of an error is not a claim that the plugin runs; a seam that cannot
  know says nothing.
- **Dependents follow their parent.** After a plugin was updated or reactivated, every
  installed plugin that `depends_on` it is reactivated, transitively and parents first,
  except those that are `inactive` (`InstallService.reactivateDependents`). A failure is
  recorded per dependent and does not stop the walk.
- **Uninstall is refused with 409** while another installed plugin depends on the target.

### Consequences

- 🟢 **Good:** The instance boots with whatever can start; the store names the rest with
  a cause an operator can act on.
- 🟢 **Good:** Installing the missing provider or fixing the manifest heals an `errored`
  plugin on the next boot.
- 🔴 **Bad:** The transient check is a regular expression over the stored message; a
  permanent error that matches is retried once per boot and trips the breaker again.
- 🔴 **Bad:** An unsatisfied capability surfaces as a degraded instance, not a failed
  start; monitoring must read plugin state, not only process health.
- 🔴 **Bad:** Reactivating dependents restarts plugins that did not change, with their
  own 10 s budget each.
- ⚪ **Neutral:** Registry files written before the code field existed carry a message
  and no code; nothing is backfilled.

## Pros and Cons of the Options

### A — Soft-fail, breaker, typed result

- 🟢 Availability first, with a readable cause.
- 🔴 More state per plugin, and heuristics for when to try again.

### B — Fail the boot

- 🟢 No half-working instance.
- 🔴 One plugin with an expired key keeps every agent offline.

### C — Retry always

- 🟢 No latch to reset.
- 🔴 A plugin that can never start costs its activation budget on every boot and floods
  the log.

## More Information

- Related: [ADR-0003](0003-capability-based-multi-provider-middleware.md) (an unsatisfied
  capability is accepted there as a consequence),
  [ADR-0053](0053-service-access-by-declaration-one-provider-per-capability.md),
  [ADR-0048](0048-one-ingest-pipeline-and-error-contract.md), [ADR-0047](0047-built-in-plugins-seeded-reconciled-sticky-uninstall.md).
- Paths: `middleware/src/plugins/installedRegistry.ts`, `activationFailure.ts`,
  `bootstrap.ts` (`retryErroredPlugins`), `toolPluginRuntime.ts`, `installService.ts`
  (`reactivate`, `reactivateDependents`), `grantGap.ts`; types in
  `middleware/src/api/admin-v1.ts`.
- Tests: `middleware/test/activationFailure.test.ts`, `bootstrap.test.ts`,
  `installServiceActivationTruthful.test.ts`, `capabilityResolver.test.ts`.
