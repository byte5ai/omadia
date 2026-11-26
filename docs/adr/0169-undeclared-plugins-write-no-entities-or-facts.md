# 0169 — A plugin that declares no entity systems writes no entities or facts

## Status

Accepted

- **Date:** 2026-11-26
- **Deciders:** Owner decision of 2026-11-26 recorded in
  [ADR-0167](0167-plugin-entity-writes-stay-in-declared-entity-systems.md) ("How the
  transition ends"); tracked by #2244.
- **Supersedes:** —
- **Refines:** [ADR-0167](0167-plugin-entity-writes-stay-in-declared-entity-systems.md)
  (ends its transition for undeclared writers).

## Context and Problem Statement

ADR-0167 holds a plugin's `knowledgeGraph@1` entity and fact writes to its declared
`permissions.graph.entity_systems`. It chose a transition (option A): a plugin that
declares nothing still writes any system that is not a kernel namespace, with one
`[security-audit]` warning per plugin and process, because the two shipped writers
(integration-odoo, integration-confluence) declared nothing yet.

ADR-0167 named the trigger that ends the transition: both plugin releases that declare
their system are on the Hub and installed on our instance, and the logs show no
undeclared-writer warning since. On 2026-11-26 that holds:

- `@omadia/integration-odoo` 0.6.1 declares `[odoo]` (integration-odoo#12),
- `@omadia/integration-confluence` 0.6.1 declares `[confluence]` (integration-confluence#9),
- both are the Hub's `latest_version` and active on Fly (kernel `sha-8e301d51`), and the
  logs after the install and after an Odoo and a Confluence turn show no
  `[security-audit] … without declaring` line.

What does an undeclared plugin get from here on?

## Decision Drivers

- ADR-0167's residual: an undeclared plugin can write any non-kernel system, `odoo` and
  `confluence` included, and the warning only makes that visible.
- One rule for both write paths. The `ctx.knowledgeGraph` accessor already exists only
  for a plugin that declares `entity_systems`; the bounded service should not be wider.
- No shipped Hub plugin may break (ADR-0044).

## Considered Options

- **A — Keep the transition** (undeclared writers pass with a warning).
- **B — Undeclared means no entity or fact writes** (ADR-0167 option B).

## Decision Outcome

Chosen option: **B**, because the trigger ADR-0167 set is met and the transition was only
ever meant to carry the two syncs until their releases were out.

- `entityWriteGuard` (`middleware/src/platform/boundedGraphServices.ts`) takes the
  declared systems only; the `'undeclared'` pass is gone. With no declared system, every
  entity is refused (`KgEntityNamespaceError` naming its system) and so is every fact,
  even one that mentions no entity (the error then names `fact`). A refused batch never
  reaches the graph; an empty batch writes nothing and passes through as before.
- The rules of ADR-0167 stay as they are for declaring plugins: the entity's `system` and
  the system of every mentioned id must be declared, a `factId` must be a fact id, kernel
  namespaces are never an entity system.
- The `[security-audit]` warning and its per-process memory are removed; a refused write is
  now an error the plugin sees.
- **Minimum plugin versions** for entity writes: `@omadia/integration-odoo` ≥ 0.6.1 and
  `@omadia/integration-confluence` ≥ 0.6.1. An older release keeps running; only its entity
  sync (off by default) fails with `KgEntityNamespaceError`.
- **Unchanged.** Modules holding the raw service (`GRAPH_BOUNDARY_IMPLEMENTERS`) are not
  bound by this rule. Reads are unaffected.

### Consequences

- 🟢 **Good:** ADR-0167's first residual is closed: a plugin that declares nothing cannot
  write any entity or fact.
- 🟢 **Good:** The bounded service and the accessor now agree: no declaration, no writes.
- 🔴 **Bad (behaviour change):** A third-party plugin that wrote entities without declaring
  `entity_systems` now gets `KgEntityNamespaceError`. None is known: the sibling plugin
  repositories were checked on 2026-11-25 (ADR-0167), and the two shipped writers now
  declare.
- 🔴 **Bad (residual, unchanged):** Any plugin may still declare `odoo` or `confluence`
  (ADR-0167). The operator is still the bound. ADR-0167's consequence that the store and
  install views "do not show `entity_systems` yet (#2245)" is settled by PR #2248, which
  shows the declaration before install and lands ahead of this change.
- ⚪ **Neutral:** On Fly both entity syncs are off (`odoo_entity_sync_enabled`,
  `confluence_entity_sync_enabled`), so the live log check could not have shown the warning
  in any case; the declared path is held by the tests below.

## Pros and Cons of the Options

### A — Keep the transition

- 🟢 No change for anyone.
- 🔴 Keeps the residual ADR-0167 accepted only until the releases were out.

### B — No writes without a declaration

- 🟢 No residual for undeclared plugins; one rule on both paths.
- 🔴 A plugin installed from an old release cannot sync entities until it is updated.

## More Information

- [ADR-0167](0167-plugin-entity-writes-stay-in-declared-entity-systems.md): the rule and the
  transition this ends.
- [ADR-0044](0044-plugins-read-the-graph-through-bounded-services.md): the bounded services.
- Tests: `middleware/test/boundedGraphServices.test.ts` (ADR-0169 cases: an undeclared
  plugin writes nothing, a declaring plugin writes its own systems).
