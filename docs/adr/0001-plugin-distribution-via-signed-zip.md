# 0001 — Plugin distribution via signed ZIP packages

## Status

Accepted

- **Date:** 2026-06-03
- **Deciders:** Core maintainers
- **Supersedes:** —

## Context and Problem Statement

Omadia is extended by **plugins**: agents, channels, and integrations that the
core middleware loads at runtime. Operators need a way to discover, install, and
update these plugins — including third-party and private ones — without
rebuilding or redeploying the core.

How should a plugin be packaged, distributed, and installed so that the model is
simple, self-hostable, and does not couple the product to any single package
ecosystem?

## Decision Drivers

- **Self-hostable:** an operator must be able to run the whole system, including
  plugin distribution, without depending on a vendor-controlled service.
- **Ecosystem-neutral:** plugins are not all JavaScript libraries; tying
  distribution to the public npm registry would leak an implementation detail
  and exclude private/closed plugins.
- **Integrity & trust:** installs must be verifiable (the bytes installed are the
  bytes published) and served over a secure transport.
- **Low operational surface:** the distribution server should be as "dumb" as
  possible; intelligence belongs in the client that the core already ships.
- **Multiple sources:** operators must be able to mix a public registry with
  internal/private registries.

## Considered Options

- **A — Signed ZIP packages installed via a thin registry client**
  Plugins are built into a self-contained ZIP whose manifest carries metadata
  (name, version, license, author). A "dumb" registry serves package bytes plus
  an index; the smart client in the core verifies a `sha256` over TLS and
  installs. Registries are admin-managed and can be stacked (public + private).
- **B — npm-based discovery and install**
  Discover plugins by scanning the public npm registry / installing npm packages
  at runtime.
- **C — Git-clone / source-build at install time**
  Pull plugin source from a Git URL and build it in place on the host.

## Decision Outcome

Chosen option: **A — Signed ZIP packages installed via a thin registry client**,
because it keeps the distribution server trivial to self-host, is neutral to the
language a plugin is written in, supports private plugins by construction, and
gives a verifiable supply chain (`sha256` + TLS) without binding the product to
npm's trust and availability model.

### Consequences

- 🟢 **Good:** Plugins are self-contained artifacts; installing one is a single
  verified download + unpack, with no transitive resolution at install time.
- 🟢 **Good:** Private and commercial plugins are first-class — they live in a
  private registry the operator controls, alongside the public one.
- 🟢 **Good:** The registry can be backed by anything that serves bytes (object
  storage or a local filesystem), so the hosted hub and an air-gapped install
  use the same mechanism.
- 🔴 **Bad:** Plugin authors must run a packaging step that produces a bundled
  ZIP (dependencies vendored into the artifact) rather than relying on a package
  manager to resolve them.
- 🔴 **Bad:** Canonical metadata lives in the plugin **manifest**, not in
  `package.json`; authors and tooling must treat the manifest as source of truth
  for license/author/version.
- ⚪ **Neutral:** Version artifacts are immutable — a change ships as a new
  version bump, never an in-place overwrite.

## Pros and Cons of the Options

### A — Signed ZIP + thin registry client

- 🟢 Self-hostable, ecosystem-neutral, verifiable, supports private plugins.
- 🟢 Server stays a static byte-store; all logic is in the client we already ship.
- 🔴 Requires a bundling/packaging step per plugin.

### B — npm discovery/install

- 🟢 Familiar tooling for JS authors; dependency resolution "for free".
- 🔴 Couples the product to npm availability and trust; excludes non-JS and
  private/closed plugins; runtime install of arbitrary npm trees is a large,
  hard-to-audit supply-chain surface.

### C — Git-clone / source-build

- 🟢 No registry to operate; works with any Git host.
- 🔴 Build toolchain must exist on every host; non-reproducible installs; no
  natural integrity check; slow and failure-prone in production.

## More Information

See [ADR-0003](0003-capability-based-multi-provider-middleware.md) for how loaded
plugins register themselves as capability providers, and
[ADR-0002](0002-mit-license-for-oss-core.md) for licensing of the core vs.
distributed plugins.
