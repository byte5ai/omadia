# 0167 — A plugin's entity writes stay in its declared entity systems

## Status

Accepted

- **Date:** 2026-11-25; the end of the transition decided by the owner on 2026-11-26.
- **Deciders:** Review follow-up of #2233 (owner task "Follow-ups aus dem Review von #2233"),
  refines [ADR-0044](0044-plugins-read-the-graph-through-bounded-services.md); landed in
  #2242. The owner (Marcel) decided on 2026-11-26 to lift the reservation of `odoo` and
  `confluence` (#2247).
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
- **Kernel namespaces.** The kernel's own node-id namespaces (`session`, `turn`, `user`,
  `plan`, `planstep`, `mk`, `excerpt`, `topic`, `run`, `agent`, `tool`, `fact`, `process`,
  `dataset`, the review queues and every channel kind) and any system with a colon in it
  are never an entity system. They are refused for every plugin, declared or not, as is a
  `factId` that is not a fact id: `entityNodeId` would otherwise build, say, a `turn:` id
  and merge the plugin's `extras` into another user's turn.
- **Facts.** The accessor's `ingestFacts` now checks too. Before, it passed everything
  ("a future hardening pass MAY").
- **`topicClustering@1`** is kernel-only for plugins: every method throws
  `GraphServiceRefusedError` (`kernel-only`) and `replace` is refused. Its reads take
  the viewer as an argument, and its re-cluster rebuilds every account's topics.
- **Transition.** A plugin that declares no `entity_systems` still writes through the
  bounded service, held only to the kernel-namespace and `factId` checks above. The first
  write per plugin and process logs a `[security-audit]` warning that names the plugin
  and the method.
- **`odoo` and `confluence` are declared, not reserved.** Until 2026-11-26 the manifest
  loader stripped these two host-reserved systems from every plugin's `entity_systems`
  (OB-29-2, `RESERVED_SYSTEMS`), so the plugins that write them could not declare them.
  The reservation is lifted: integration-odoo declares `[odoo]`, integration-confluence
  `[confluence]` (integration-odoo#11, integration-confluence#8). The loader still drops
  the kernel namespaces and any value with a colon (`isKernelReservedSystem` in
  `middleware/src/platform/kernelNodeNamespaces.ts`, shared with the write guard), so the
  summary the operator sees is what the plugin can write. A kernel map from system to
  owning plugin was the alternative; it was not chosen, because it would hard-code two
  plugin ids in the kernel and need a kernel release for every new integration.
- **How the transition ends.** It ends when both plugin releases that declare their
  system are published on the Hub and installed on our instance, and the logs show no
  undeclared-writer warning since. Then one kernel PR removes the undeclared pass from
  `entityWriteGuard`: undeclared means no entity or fact writes (option B), recorded by a
  new ADR that refines this one. #2244 tracks the trigger.
- **Unchanged.** Modules holding the raw service (`GRAPH_BOUNDARY_IMPLEMENTERS`: fact
  extraction in orchestrator-extras, the providers) are not bound by this rule.

### Consequences

- 🟢 **Good:** A plugin that declares its systems can no longer write into another
  plugin's system, through either path.
- 🟢 **Good:** The accessor and the service enforce one rule from one function.
- 🔴 **Bad (residual):** Until the transition ends, a plugin that declares nothing can
  still write any system that is not a kernel namespace, `odoo` and `confluence`
  included. The warning makes that visible in the logs. It does not prevent it.
- 🔴 **Bad (residual):** Any plugin may declare `odoo` or `confluence` and then write
  Odoo or Confluence master-data nodes. Nothing ties a system to one plugin; the bound is
  the operator, who must see the declaration before install. The store and install views
  do not show `entity_systems` yet (#2245).
- 🔴 **Bad (behaviour change):** A plugin whose facts mention entities of a system it
  does not declare, or whose `factId` is not a fact id, now gets an error from
  `ctx.knowledgeGraph.ingestFacts`. The contract had said such mentions were fine. No
  plugin calls `ingestFacts`: checked in this repository and the sibling plugin
  repositories on 2026-11-25.
- 🔴 **Bad (residual):** A fact's `sourceTurnId` is not checked. A plugin can link its own
  fact to any turn it knows the id of. That changes no entity's capturing turns, because
  the edge starts at the fact node, but the fact is shown wherever that turn is.
- ⚪ **Neutral:** Follow-ups: integration-odoo#11 and integration-confluence#8 (declare),
  #2244 (end of the transition), #2245 (show the declaration before install).

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
  `middleware/test/agent-reference-maximum/kgAccessor.test.ts`,
  `middleware/test/entitySystemsManifest.test.ts` (loader keeps `odoo` / `confluence`,
  drops kernel namespaces).
