# 0015 — Agent archetypes, delivered by archetype plugins

## Status

Accepted — superseded in part by [ADR-0166](0166-archetype-plugin-database-roles-are-opt-in.md) (own database roles are opt-in)

- **Date:** 2026-11-19
- **Deciders:** Owner (byte5); spec author iret77
- **Supersedes:** the closed `agents.kind` column of migration 0067 (#2092), retired in the contract step

## Context and Problem Statement

Some agents are a different *kind of colleague*, not a different persona: a facilitator
must be impartial, so it deliberately lacks business capabilities, memory and
consultation. #2092 modelled this as `agents.kind` with hard-coded omissions in about
15 files, and bound the engine through an `extension` plugin with a SQL grant on the
shared core pool. More archetypes will follow.

How does omadia add a new kind of agent without forking the kernel, while the kernel
stays responsible for every agent?

## Decision Drivers

- An agent's fundamental role must not change after creation (no identity switching).
- New archetypes should be deliverable without kernel releases, as plugins.
- The kernel must enforce omissions and every invariant for every archetype; a plugin
  cannot be trusted to self-limit.
- A plugin with process state must not reach kernel tables.

## Considered Options

- **A — Archetype registry in the kernel; archetype plugins with an enforced descriptor**
- **B — Closed `agents.kind` enum in the kernel** (the #2092 state)
- **C — Archetypes as configuration presets of a standard agent**

## Decision Outcome

Chosen option: **A**.

- `agents.archetype` (default `standard`), set at creation and immutable. The kernel keeps
  an **archetype registry**; `standard` is built in, archetype plugins (manifest kind
  `archetype`) register others. Today: `facilitator`
  ([ADR-0022](0022-native-facilitators-as-an-archetype-plugin.md)).
- An archetype plugin declares a **descriptor** the kernel enforces: what it inherits,
  adds and deliberately omits (grants, memory, consultation, default-agent role, fast
  lane …), its role contract and persona bounds. An unregistered archetype omits
  everything.
- **The kernel stays responsible** for identity, speaker, INV-1 to INV-11, refusal of
  omitted grants, discretion and **every model turn** (agent turn with model policy,
  privacy shield, budgets, deadlines, kill switch).
- **Every action of an archetype plugin's process** (model turns and model-free posts,
  deliveries, checks) needs a kernel **execution authorization** under a bounded
  **execution scope** with deadline, budget, run counter and allowed targets.
- **Database:** an archetype plugin owns its process tables but gets a role limited to its
  own schema (plus a migration role for that schema), never the shared core pool; kernel
  tables are unreachable.
- **Install and removal:** installing asks for explicit confirmation that a new kind of
  agent is added. Uninstall is kernel-guarded: running processes end as `aborted`,
  reservations, scopes, grants and jobs are revoked, a `system` notice goes to each home
  conversation; agents are disabled, never converted. The same end-of-service procedure
  runs when one agent is disabled or deleted.
- **Rollout:** expand/contract on live instances: `agents.kind` stays next to
  `agents.archetype` (sync trigger) until the contract step, because an older machine
  would read an unknown kind as `standard` and switch omissions off.

### Consequences

- 🟢 **Good:** New colleague types ship as plugins; the kernel guarantees stay uniform.
- 🟢 **Good:** Omissions become data (descriptor) instead of scattered `if facilitator`.
- 🔴 **Bad:** Kernel needs schema-scoped DB roles, execution scopes and guarded uninstall
  before any third-party archetype is safe.
- ⚪ **Neutral:** Issues #2088 to #2091, #2078; steps K1 (#2104, merged) to K6.

## Pros and Cons of the Options

### A — Registry plus enforced descriptor

- 🟢 Extensible and enforceable.
- 🔴 Most kernel work up front.

### B — Closed enum

- 🟢 Simple, already built.
- 🔴 Every new archetype is a kernel change; omissions are hard-coded.

### C — Presets of a standard agent

- 🟢 No new concept.
- 🔴 A preset can be edited away; impartiality would depend on configuration discipline.

## More Information

- Spec A §5.1, §5.10 ("Archetype contract", "Database access of archetype plugins",
  "Uninstall is kernel-guarded", "End of service of an agent"); acceptance criterion 37.
- Spec B (`specs/2043-native-facilitators/spec.md`) §0, §0.1.
- Related: [ADR-0014](0014-plugins-are-only-the-delivery-form.md),
  [ADR-0017](0017-model-gateway-and-execution-contexts.md).
