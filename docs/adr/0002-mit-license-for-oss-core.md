# 0002 — MIT license for the open-source core

## Status

Accepted

- **Date:** 2026-06-03
- **Deciders:** Core maintainers
- **Supersedes:** —

## Context and Problem Statement

Omadia is released as open source. The license choice shapes who can adopt it,
how plugins (including commercial ones) may build on top, and how much friction
enterprises face when embedding it. We need an explicit, deliberate license
decision rather than an implicit default.

Which license should the open-source core ship under?

## Decision Drivers

- **Maximize adoption:** lower the barrier for companies to try, embed, and ship
  products on top of the core.
- **Enable a plugin ecosystem, including commercial plugins:** third parties must
  be able to build proprietary plugins without a copyleft obligation forcing
  their source open.
- **Low legal-review friction:** a license enterprises' legal teams already know
  and approve by reflex.
- **Compatibility:** must combine cleanly with the permissive licenses of the
  core's dependencies.

## Considered Options

- **A — MIT** — short, permissive, ubiquitous.
- **B — Apache-2.0** — permissive with an explicit patent grant and NOTICE
  requirements.
- **C — AGPL-3.0** — strong copyleft, including over a network boundary.

## Decision Outcome

Chosen option: **A — MIT**, because it imposes the least friction on adoption and
on building plugins (commercial included), is instantly recognizable to
enterprise legal review, and matches the permissive licensing of the surrounding
ecosystem. The product's value is in the agentic platform and the hosted/managed
experience, not in license-enforced exclusivity, so copyleft would cost adoption
without protecting what matters.

### Consequences

- 🟢 **Good:** Anyone can embed, fork, and ship — including in closed-source
  products — which is the right incentive for a young platform seeking adoption.
- 🟢 **Good:** Plugin authors can license their own plugins however they like
  (MIT-permissive core does not infect them); the distribution model in
  [ADR-0001](0001-plugin-distribution-via-signed-zip.md) already supports private
  artifacts.
- 🔴 **Bad:** No reciprocity — downstream forks are not obligated to contribute
  improvements back, and a competitor could build a closed offering on the core.
- 🔴 **Bad:** No explicit patent grant (unlike Apache-2.0); patent protection
  relies on the implied license only.
- ⚪ **Neutral:** Each distributed plugin declares its own license in its
  manifest; the core's MIT choice does not dictate plugin licensing.

## Pros and Cons of the Options

### A — MIT

- 🟢 Maximal adoption, trivial compliance, ecosystem-standard.
- 🔴 No reciprocity; no explicit patent grant.

### B — Apache-2.0

- 🟢 Explicit patent grant; still permissive and enterprise-friendly.
- 🔴 NOTICE/attribution mechanics add minor friction; longer text; marginally
  less ubiquitous than MIT for a small core.

### C — AGPL-3.0

- 🟢 Forces network-deployed derivatives to publish source — protects against a
  closed SaaS competitor.
- 🔴 Copyleft (especially network copyleft) is an adoption-killer for many
  enterprises and is incompatible with a thriving commercial-plugin ecosystem.

## More Information

License metadata for distributed plugins lives in their manifest — see
[ADR-0001](0001-plugin-distribution-via-signed-zip.md).
