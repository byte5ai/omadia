# 0166 — Own database roles for archetype plugins are opt-in; `graphPool` for archetypes is deprecated

## Status

Accepted

- **Date:** 2026-11-25
- **Deciders:** Owner (byte5), from the ADR-coverage audit of 2026-11-25
- **Supersedes:** [ADR-0015](0015-agent-archetypes-and-archetype-plugins.md) in part: its
  "never the shared core pool" for archetype plugins' databases

## Context and Problem Statement

ADR-0015 gives an archetype plugin a role limited to its own schema, plus a migration role,
and never the shared core pool. The kernel does this only for an archetype plugin that does
not require `graphPool` (`ownsItsDatabase`, `middleware/src/platform/archetypeDatabase.ts`);
one that requires it keeps the shared pool, like every other plugin
([ADR-0050](0050-plugin-database-access-declared-granted-and-kernel-run-migrations.md)).

Making the own roles mandatory would cost:

- two `LOGIN` roles and two pools per plugin on Neon's transaction pooler;
- `CREATEROLE` rights and Postgres 16+ on every instance, or activation fails
  (`cannot_create_roles`);
- moving each existing plugin's tables from `public` to `plg_<id>` and rewriting its code
  from the pool to `ctx.sql`.

Should the kernel force own roles on archetype plugins now?

## Decision Drivers

- Archetype plugins already ship against `graphPool`; a hard switch breaks them on live
  instances.
- Instances without `CREATEROLE` must keep running archetype plugins.
- The confinement must stay the target, not become optional forever.

## Considered Options

- **A — Opt-in now, `graphPool` for archetypes deprecated**
- **B — Mandatory own roles now**
- **C — Opt-in with no end date**

## Decision Outcome

Chosen option: **A**.

- An archetype plugin that does not require `graphPool` gets its own schema, runtime role and
  migration role (unchanged behaviour). One that requires `graphPool` keeps the shared pool
  under the grant rules of ADR-0050.
- `graphPool` for archetype plugins is deprecated. The kernel refuses it for archetypes with
  plugin-api 2.0.0. New archetype plugins are written against `ctx.sql`.

### Consequences

- 🟢 **Good:** No live archetype plugin breaks; instances without `CREATEROLE` keep working.
- 🔴 **Bad:** Until plugin-api 2.0.0 an archetype plugin that requires `graphPool` can read
  kernel tables like any other SQL-granted plugin.
- ⚪ **Neutral:** Plugin-api 2.0.0 must ship the refusal and a migration path for archetypes'
  tables.

## Pros and Cons of the Options

### A — Opt-in, deprecated

- 🟢 Keeps live plugins working and names the end.
- 🔴 The weaker form stays possible for a while.

### B — Mandatory now

- 🟢 Confinement for every archetype at once.
- 🔴 Breaks live plugins and instances without `CREATEROLE`; table moves on live data.

### C — Opt-in forever

- 🔴 The ADR-0015 confinement would never become the rule.

## More Information

- Related: [ADR-0015](0015-agent-archetypes-and-archetype-plugins.md),
  [ADR-0050](0050-plugin-database-access-declared-granted-and-kernel-run-migrations.md),
  [ADR-0034](0034-no-session-state-behind-a-transaction-pooler.md).
