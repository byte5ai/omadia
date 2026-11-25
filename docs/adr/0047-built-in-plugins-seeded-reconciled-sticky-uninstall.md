# 0047 — Built-in plugins: seeded at boot, version follows the image, an operator uninstall sticks

## Status

Accepted

- **Date:** 2026-11-25
- **Deciders:** omadia maintainers (recorded retroactively from the code on main); sticky uninstall #1481, version reconcile #1505, install origin #1089, package origin #789/#794, provider collision check OM-87 / #1053
- **Supersedes:** —

## Context and Problem Statement

The middleware image ships plugin packages of its own (`middleware/packages/*`): the agent
runtime, memory, knowledge graph, embeddings, verifier, tools. They go through the same
catalog and installed registry as packages an operator uploads
([ADR-0003](0003-capability-based-multi-provider-middleware.md): the core ships no
mandatory provider, an instance is assembled from plugins). Three questions were answered
by accident before. A boot seeder re-installed every missing built-in, so an operator's
uninstall lasted until the next restart. The registry kept the version from the first
install, so after an image update it disagreed with what ran, and profile bundles that
pinned it were rejected. And a package could claim a built-in's id. This record is written
retroactively; the decision is implemented on main.

Which built-ins are installed without an operator, what does the registry say about them,
and whose decision wins?

## Decision Drivers

- A fresh instance must work without a manual install of infrastructure plugins.
- An operator's uninstall is a decision the system must remember.
- The registry states what runs.
- Whether a package is bundled must not be something the package can claim.
- Never install a second provider of a capability that already has an active one.

## Considered Options

- **A — Seed at boot, with a persisted opt-out, a version reconcile and a caller-asserted
  package origin**
- **B — Built-ins are always on and cannot be uninstalled**
- **C — Nothing is seeded; the operator installs every built-in from the store**

## Decision Outcome

Chosen option: **A**.

- **Seeding** (`bootstrapBuiltInPackages` in `middleware/src/plugins/bootstrap.ts`): every
  built-in missing from the registry gets an `active` entry with `origin: 'bundled'` and
  its non-secret manifest defaults as config, unless
  - the operator uninstalled it (opt-out, below);
  - it declares a `secret` or `oauth` setup field: it stays "available" until the operator
    runs the setup flow;
  - it is a knowledge-graph or alternative memory-store provider: those are opt-in;
  - a capability it provides already has an active provider.
- **Boot-managed providers.** Memory, knowledge graph, embeddings and the agent runtime
  are selected by `bootstrap*FromEnv` from the environment (for example the Postgres
  knowledge graph when `DATABASE_URL` is set, the in-memory one otherwise). The host needs
  them, so an uninstall of one of `BOOT_MANAGED_BUILT_IN_IDS` does not stick, and the
  uninstall dialog says so. The memory backend follows the environment on every boot
  (the non-selected provider is removed); a knowledge-graph provider, once installed, is
  not flipped by a later environment change.
- **Sticky uninstall.** `InstallService.uninstall` records the id in
  `builtin-uninstalls.json` next to `installed.json` (`builtInOptOuts.ts`); the seeders
  skip recorded ids; installing the plugin again clears the mark. An unreadable file is
  moved to `<file>.corrupt` and the store starts empty: a broken preference list must not
  stop the boot.
- **The version follows the image.** `reconcileBuiltInVersions` sets `installed_version`
  of every entry whose catalog entry has origin `bundled` to the shipped version on every
  boot, also downwards on an older image.
- **Two different "origin" facts.** The catalog entry's `origin` (`bundled` or
  `installed`) says where the package was found and is asserted by the loader's caller,
  never read from the manifest. The registry entry's `origin` says who wrote the install.
  It is absent on entries older than the field and is read as unknown, never backfilled.
- **A built-in's id is protected at ingest** (`package.id_conflict_builtin`,
  `package.id_conflict_bundled`; see [ADR-0048](0048-one-ingest-pipeline-and-error-contract.md)), and
  legacy ramps apply only to origin `bundled`.
- **Source precedence in the catalog** is local dev (`PLUGIN_DEV_DIR`, unset by default)
  over uploaded over built-in over example manifests.

### Consequences

- 🟢 **Good:** A new instance boots into a working set; an operator's uninstall survives
  restarts and image updates.
- 🟢 **Good:** The store's update check and profile bundles compare against the version
  that actually runs.
- 🔴 **Bad:** The opt-out lives in a JSON file on the data volume; an instance restored
  without that file gets the uninstalled built-ins back.
- 🔴 **Bad:** Six ids are boot-managed by a hard-coded list; uninstalling one of them is
  possible in the UI but undone at the next boot.
- 🔴 **Bad:** Seeding copies manifest defaults once; a default changed in a later image
  does not reach an existing install.
- ⚪ **Neutral:** Auto-installing a built-in attaches it to no agent
  ([ADR-0016](0016-least-privilege-and-the-agent-envelope.md)).

## Pros and Cons of the Options

### A — Seed with opt-out and reconcile

- 🟢 Works out of the box and respects the operator.
- 🔴 A second file of state and a list of exceptions to keep correct.

### B — Always on

- 🟢 No lifecycle to model.
- 🔴 Contradicts the empty core of ADR-0003; an operator cannot remove a tool they do not
  want.

### C — Nothing seeded

- 🟢 Every install is a decision.
- 🔴 A fresh instance cannot answer until the operator has installed infrastructure they
  have no reason to know about.

## More Information

- Related: [ADR-0003](0003-capability-based-multi-provider-middleware.md),
  [ADR-0016](0016-least-privilege-and-the-agent-envelope.md),
  [ADR-0053](0053-service-access-by-declaration-one-provider-per-capability.md),
  [ADR-0046](0046-activation-soft-fail-circuit-breaker-and-typed-result.md).
- Paths: `middleware/src/plugins/bootstrap.ts`, `builtInOptOuts.ts`,
  `builtInPackageStore.ts`, `localDevPackageStore.ts`, `installedRegistry.ts`
  (`InstallOrigin`), `manifestLoader.ts` (`PluginOrigin`), `installService.ts`.
- Tests: `middleware/test/builtInLifecycle.test.ts`, `bootstrap.test.ts`,
  `builtInPackageStore.test.ts`, `leastPrivilegeByDefault.test.ts`.
