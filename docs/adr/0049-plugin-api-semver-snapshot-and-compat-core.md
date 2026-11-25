# 0049 — plugin-api is versioned by its type surface; a snapshot guards it and `compat.core` is enforced where a package comes in

## Status

Accepted

- **Date:** 2026-11-25
- **Deciders:** omadia maintainers (recorded retroactively from the code on main); snapshot gate from epic #470 (item C1, decision D1), `compat.core` enforcement and minimum startable versions from #1463
- **Supersedes:** —

## Context and Problem Statement

`@omadia/plugin-api` is the type contract every plugin compiles against. Since the plugins
moved into their own repositories, a breaking change in it no longer fails in the commit
that makes it: every in-repo consumer is recompiled together, `tsc` stays green, and the
break shows up at install time on someone else's instance. A plugin also imports the
package from the host at runtime, so a plugin built against a newer contract can name an
export the host lacks, and an ESM named import of a missing export fails the whole module
at link time. The manifest field `compat.core` existed but was only read, never enforced.
This record is written retroactively; the decision is implemented on main.

How does the contract change in a way plugin authors can rely on, and how does a host
refuse a package it cannot run?

## Decision Drivers

- A breaking change must be visible in the pull request that causes it.
- An out-of-repo plugin has one signal about its pinned contract: the version number.
- A package the host cannot run must be refused before it is stored, with a message an
  operator can act on, not at the first activation.
- Already installed plugins must keep booting after a core update wherever they can.

## Considered Options

- **A — SemVer over the exported type surface, a committed declaration snapshot, and an
  enforced `compat.core` range**
- **B — Convention only** (review discipline; `compat.core` stays informational)
- **C — Publish the package to npm and let each plugin's package manager resolve it**

## Decision Outcome

Chosen option: **A**.

- **The package is `private: true` and is not published.** In-repo consumers resolve it
  through the npm workspace; plugin repositories use a `file:` link, a vendored `.d.ts` or
  a git tag (`middleware/packages/plugin-api/README.md`).
- **SemVer is over the exported type surface.** Removing or renaming a symbol, adding a
  parameter, narrowing a type or making an optional field required is a **major**; adding
  a symbol, widening a type or making a required field optional is a **minor**. Every
  change gets a `CHANGELOG.md` entry.
- **The surface is machine-checked.** `api-snapshot/plugin-api.d.ts.snap` holds every
  declaration the package emits, comments stripped and whitespace collapsed, files in
  sorted path order. `test/apiSnapshot.test.ts` regenerates it from `src/` into a temporary
  directory (never `dist/`) and fails on any difference. An intended change runs
  `npm run api:update`, commits the snapshot with the source change and bumps the version.
- **`compat.core` is a semver range over the host's plugin-api version** (default
  `>=1.0 <2.0`), checked by `checkCoreCompat` in `middleware/src/plugins/coreCompat.ts`:
  - `PackageUploadService.ingest` refuses every ZIP (upload, Hub install, `depends_on`
    chain, builder install, vendored profile bundle) with `package.incompatible_core`
    before it is stored;
  - `InstallService.create` refuses a catalog entry with `install.incompatible_core`
    (HTTP 409), which also covers a package uploaded before the ingest check existed.
  - Not gated: profile apply and the boot of plugins that are already installed.
  - Prereleases count (`includePrerelease`); a range that is not valid semver is refused
    as `invalid_range`.
- **Minimum startable versions.** `MINIMUM_STARTABLE_VERSIONS` lists published versions
  whose range still admits the host but which the core cannot start (five plugin ids
  today). `assertStartable` runs in the runtimes before a plugin's own `activate()`, so
  this part also applies to an installed plugin after a core update.

### Consequences

- 🟢 **Good:** A contract change is a reviewable diff, and the bump rule is written next
  to the gate.
- 🟢 **Good:** An incompatible package is refused once, at the door, by all install paths
  with the same code.
- 🔴 **Bad:** The contract stays in major 1 only as long as every change is additive;
  the package is at 1.94.0, and plugins raise their `compat.core` floor by hand for each
  feature they use.
- 🔴 **Bad:** `MINIMUM_STARTABLE_VERSIONS` is a hand-kept list in the kernel that names
  plugin ids; the Hub index has no yank field the core could read instead.
- 🔴 **Bad:** An installed plugin whose range no longer admits the host still boots and
  fails only at link time or first use; the range is enforced only where a package enters.
- ⚪ **Neutral:** Comments are not part of the snapshot; a reworded JSDoc is no API change.

## Pros and Cons of the Options

### A — SemVer over the type surface, snapshot, enforced range

- 🟢 Breaks are visible at authoring time and refused at install time.
- 🔴 Every contract change costs a snapshot update, a version bump and a changelog entry.

### B — Convention only

- 🟢 No tooling.
- 🔴 A break is found by an operator at install time; the version number carries no
  guarantee.

### C — Publish to npm

- 🟢 Standard resolution for plugin authors.
- 🔴 The version a plugin resolves at build time is still not the host's version it links
  against at runtime, so the range check is needed anyway;
  [ADR-0001](0001-plugin-distribution-via-signed-zip.md) keeps distribution off npm.

## More Information

- Related: [ADR-0001](0001-plugin-distribution-via-signed-zip.md) (package delivery),
  [ADR-0003](0003-capability-based-multi-provider-middleware.md) (capability interfaces
  are a public contract), [ADR-0048](0048-one-ingest-pipeline-and-error-contract.md).
- Paths: `middleware/packages/plugin-api/README.md`, `CHANGELOG.md`,
  `scripts/api-snapshot.mjs`, `api-snapshot/plugin-api.d.ts.snap`;
  `middleware/src/plugins/coreCompat.ts`.
- Tests: `middleware/packages/plugin-api/test/apiSnapshot.test.ts`,
  `middleware/test/coreCompat.test.ts`, `middleware/test/installUploadErrorContract.test.ts`.
- Author-facing: `docs/creating-plugins.md` states the `compat.core` floor per feature.
