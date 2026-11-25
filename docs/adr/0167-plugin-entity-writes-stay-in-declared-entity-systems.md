# 0167 — A plugin's entity writes stay in its declared entity systems

## Status

Proposed

- **Date:** 2026-11-25
- **Deciders:** Review follow-up of #2233 (owner task "Follow-ups aus dem Review von #2233"),
  refines [ADR-0044](0044-plugins-read-the-graph-through-bounded-services.md).
- **Number:** 0165 and 0166 are reserved by PR C of the ADR-deviation session (#2238).

## Context and Problem Statement

Entity nodes carry a source system in their id (`<system>:<model>:<id>`, `odoo:res.partner:42`).
The `ctx.knowledgeGraph` accessor (OB-29-2) exists only for a plugin whose manifest declares
`permissions.graph.entity_systems`, and its `ingestEntities` refuses any other system with
`KgEntityNamespaceError`. Its `ingestFacts` checked nothing.

[ADR-0044](0044-plugins-read-the-graph-through-bounded-services.md) classed `ingestEntities`
and `ingestFacts` of the bounded `knowledgeGraph@1` service as **pass**, while the code
described them as "the plugin's own entity writes". Nothing checked "own": a plugin holding
`requires: ["knowledgeGraph@^1"]` could overwrite another system's master data, such as
Odoo partners from a Confluence plugin, or attach facts to it.

The shipped writers are integration-odoo (`odoo`) and integration-confluence (`confluence`).
Both write through `ctx.services.get('knowledgeGraph')`, and neither manifest declares
`entity_systems` (both `origin/main`, 2026-11-20). What is "own", and what happens to a
plugin that declares nothing?

## Decision Drivers

- One rule for both write paths, the accessor and the service.
- The declaration that already exists (`permissions.graph.entity_systems`) is the bound.
  No new manifest key.
- No shipped Hub plugin may break (ADR-0044).

## Considered Options

- **A — Hold writes to the declared systems; let undeclared writers through for a
  transition, with a warning.**
- **B — Hold writes to the declared systems strictly; undeclared means no entity writes.**
- **C — Keep pass and record that the service does not check systems.**

## Decision Outcome

Chosen option: **A**.

- **The rule.** An entity's `system` and the system prefix of every id in a fact's
  `mentionedEntityIds` must be one of the plugin's `permissions.graph.entity_systems`.
  A fact's own `factId` must be a fact id (`fact:…`, `factNodeId`): both providers upsert
  the node by that id whatever its type, so a `factId` of `odoo:res.partner:42` would
  write into the partner and give it a `DERIVED_FROM` edge to a turn.
  Otherwise the write throws `KgEntityNamespaceError` and nothing reaches the graph.
  `entityWriteGuard` in `middleware/src/platform/boundedGraphServices.ts` implements the
  rule. The accessor and the bounded service (method class `entity-write` in
  `KG_METHOD_ACCESS`) both use it.
- **Facts.** The accessor's `ingestFacts` now checks too. Before, it passed everything
  ("a future hardening pass MAY").
- **Transition.** A plugin that declares no `entity_systems` still writes through the
  bounded service. The first write per plugin and process logs a `[security-audit]`
  warning that names the plugin and the method. The transition ends once the Odoo and
  Confluence manifests declare their systems and are live. Then undeclared means
  refused (option B), recorded by a new ADR.
- **Unchanged.** Modules holding the raw service (`GRAPH_BOUNDARY_IMPLEMENTERS`: fact
  extraction in orchestrator-extras, the providers) are not bound by this rule.

### Consequences

- 🟢 **Good:** A plugin that declares its systems can no longer write into another
  plugin's system, through either path.
- 🟢 **Good:** The accessor and the service enforce one rule from one function.
- 🔴 **Bad (residual):** Until the transition ends, a plugin that declares nothing can
  still write any system. The warning makes that visible in the logs. It does not
  prevent it.
- 🔴 **Bad (behaviour change):** A plugin whose facts mention entities of a system it
  does not declare, or whose `factId` is not a fact id, now gets an error from
  `ctx.knowledgeGraph.ingestFacts`. The contract had said such mentions were fine. No
  plugin calls `ingestFacts`: checked in this repository and the sibling plugin
  repositories on 2026-11-25.
- 🔴 **Bad (residual):** A fact's `sourceTurnId` is not checked. A plugin can link its own
  fact to any turn it knows the id of. That changes no entity's capturing turns, because
  the edge starts at the fact node, but the fact is shown wherever that turn is.
- ⚪ **Neutral:** Follow-up: add `graph.entity_systems: [odoo]` to integration-odoo and
  `[confluence]` to integration-confluence, publish both, then end the transition.

## Pros and Cons of the Options

### A — Declared systems, transition for undeclared writers

- 🟢 Closes the gap for every plugin that declares, now, without breaking the live syncs.
- 🔴 Leaves undeclared writers open until the plugin releases are out.

### B — Strict at once

- 🟢 No residual.
- 🔴 Stops the Odoo and Confluence entity syncs on the next deploy, before their
  manifests can declare anything.

### C — Keep pass

- 🟢 No change.
- 🔴 The ADR-0044 wording would stay wrong, and the service would remain a side door
  around the accessor's check.

## More Information

- [ADR-0044](0044-plugins-read-the-graph-through-bounded-services.md): the bounded services
  and `KG_METHOD_ACCESS`.
- Tests: `middleware/test/boundedGraphServices.test.ts` (ADR-0167 cases),
  `middleware/test/agent-reference-maximum/kgAccessor.test.ts`.
