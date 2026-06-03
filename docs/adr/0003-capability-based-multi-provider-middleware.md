# 0003 — Capability-based, multi-provider middleware

## Status

Accepted

- **Date:** 2026-06-03
- **Deciders:** Core maintainers
- **Supersedes:** —

## Context and Problem Statement

The middleware that runs an Omadia agent needs many concrete services: an LLM,
embeddings, a knowledge-graph store, diagram rendering, document generation, and
so on. Early on these risked being wired in as hard-coded dependencies, which
would make the core impossible to run without a specific vendor and impossible to
extend without editing the core.

How should the core depend on these services so that it stays "empty" — shipping
no mandatory provider — while operators and plugins supply concrete
implementations?

## Decision Drivers

- **Empty core:** the middleware should boot with *no* baked-in provider and let
  the operator choose what backs each service.
- **Pluggable per service:** swapping the LLM, the embedder, or the graph store
  must not touch unrelated code.
- **Multiple providers per service:** more than one implementation of the same
  service may be installed at once (e.g. different LLMs for different agents).
- **Plugin-supplied:** the same plugin mechanism
  ([ADR-0001](0001-plugin-distribution-via-signed-zip.md)) that adds channels and
  integrations should also add these service providers.
- **Discoverable & testable:** the core must resolve a provider for a given
  service through one consistent contract, easy to fake in tests.

## Considered Options

- **A — Capability registry with multiple providers per capability**
  Define each service as a named **capability** (a typed interface). Providers
  register against a capability; the core resolves a provider by capability at
  runtime. Several providers may coexist for the same capability, selected by
  configuration.
- **B — Single hard-coded provider per service**
  Pick one implementation per service, compiled into the core.
- **C — One provider per capability (single-binding registry)**
  A registry, but each capability can have at most one bound provider.

## Decision Outcome

Chosen option: **A — Capability registry with multiple providers per
capability**, because it keeps the core empty and vendor-neutral, lets operators
mix providers (including several implementations of the same capability), and
reuses the plugin system as the delivery vehicle for providers. The core depends
only on capability *interfaces*, never on concrete vendors.

### Consequences

- 🟢 **Good:** The core boots with no mandatory provider; an operator assembles a
  working system by installing the plugins they want.
- 🟢 **Good:** Any service — LLM, embeddings, graph store, renderers, document
  tools — is swappable in isolation and faked easily in tests.
- 🟢 **Good:** Several providers of the same capability can be active at once, so
  different agents or tenants can use different backends.
- 🔴 **Bad:** Indirection cost — every service call goes through capability
  resolution, and a misconfigured install can boot with an unsatisfied
  capability that only fails when first exercised.
- 🔴 **Bad:** Capability interfaces are now a public contract; changing one is a
  breaking change for every provider implementing it.
- ⚪ **Neutral:** Selection logic (which provider answers a capability when
  several are registered) becomes configuration the operator must understand.

## Pros and Cons of the Options

### A — Multi-provider capability registry

- 🟢 Empty, vendor-neutral core; per-service pluggability; multiple coexisting
  providers; reuses the plugin system.
- 🔴 Resolution indirection; capability interfaces become a stable public API.

### B — Hard-coded single provider

- 🟢 Simplest to read; no resolution layer; fails fast at compile time.
- 🔴 Couples the core to vendors; not self-hostable on a different stack; every
  swap edits the core.

### C — Single-binding registry

- 🟢 Pluggable and testable, with simpler resolution than A.
- 🔴 Cannot run two implementations of one capability simultaneously — blocks
  per-agent / per-tenant provider choice.

## More Information

The knowledge-graph store is one such capability — see
[ADR-0004](0004-knowledge-graph-as-memory-substrate.md). Providers are delivered
as plugins per [ADR-0001](0001-plugin-distribution-via-signed-zip.md).
