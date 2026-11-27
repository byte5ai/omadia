# 0255 — A granted `graphPool` covers only the plugin's own tables

## Status

Accepted

- **Date:** 2026-11-26
- **Deciders:** Owner decision by recommendation (wave 5, cluster W30; reversible), from
  #2230.
- **Supersedes:** —
- **Refines:** [ADR-0044](0044-plugins-read-the-graph-through-bounded-services.md) (its
  `graphPool` residual), [ADR-0050](0050-plugin-database-access-declared-granted-and-kernel-run-migrations.md).

## Context and Problem Statement

`graphPool` is the kernel's own `pg.Pool`. A plugin gets it only with a manifest
declaration, `permissions.sql` and an operator grant (C7, ADR-0050), and borrows it
(`borrowedPool.ts` blocks `end()`). ADR-0044 left it without a bounded form: the owner
decided on 2026-11-25 that it stays an operator-granted capability and that a table guard
is a separate decision.

Until now the borrowed pool passed every statement through. A granted plugin could
`SELECT` the kernel's graph, memory, user and audit tables past the turn's graph read
boundary (ADR-0040). It could also read the pool's `options` (the connection string) or
register `on('connect')` and receive core's raw clients. Two Hub plugins hold the pool
today: channel-teams (`teams_*` tables) and dev-platform (`dev_*` tables). An audit of both
at `origin/main` (2026-11-26) found only their own tables, `pool.query`, `pool.connect`
with `BEGIN`/`COMMIT`, and no dollar quotes, `DO`, functions or dynamic SQL.

What may a plugin's SQL on the borrowed pool name?

## Decision Drivers

- A SQL grant is consent to the plugin's own tables, not to the tenant's data.
- channel-teams and dev-platform keep working without a release.
- Fail closed: what the guard cannot read is refused, not passed.
- No SQL parser dependency; the guard must be small enough to review.

## Considered Options

- **A — Conservative deny list on the borrowed pool.** Tokenise each statement, refuse
  any that names a kernel relation, fail closed on what the tokeniser cannot read.
- **B — Move the holders to `ctx.sql` with their own schema** (#2088, the archetype path,
  ADR-0166). The plugin's role sees only its schema.
- **C — Keep passing statements through** and rely on the grant.

## Decision Outcome

Chosen option: **A**, the recommendation of the recheck, because it closes the read path
now without a plugin release, and B needs a schema migration in both plugins.

- **Who is guarded.** Every plugin whose catalog entry is not `origin === 'bundled'`
  (`pluginContext.ts`: `borrowPool(…, { guardStatements })`). Bundled modules (the
  verifier, the boundary implementers) are reviewed in this repository and keep the pool
  as before. An upload or local-dev package shadowing a bundled id is guarded.
- **Kernel relations.** `KERNEL_SQL_RELATIONS` (`kernelSqlRelations.ts`) lists every table,
  view and function a kernel migration series or store creates.
  `test/kernelSqlRelations.test.ts` scans them all and fails on a name the list misses.
- **The rule.** `sqlTableGuard.ts` skips comments and string literals and compares every
  identifier (bare, quoted, each part of a qualified name, case-folded) with the list. One
  hit refuses the whole statement with `SqlTableRefusedError`, before it reaches Postgres
  (as a rejected promise, or through the callback).
- **Plugin-owned kernel tables.** Tables core migrations created for a plugin before it
  left the tree belong to that plugin only (`PLUGIN_OWNED_KERNEL_RELATIONS`):
  - channel-teams: `teams_conversation_refs`, `teams_attachments`;
  - dev-platform: the nine `dev_*` tables.
  A `plg_…` name outside the plugin's own `plg_<plugin>` namespace is refused (another
  plugin's ledger or schema).
- **Fail closed.** Refused:
  - an unterminated string, quoted identifier or comment;
  - dollar-quoted text;
  - `U&` escapes;
  - `DO` as a statement and `CREATE [OR REPLACE] FUNCTION | PROCEDURE`;
  - functions that run SQL text or read a relation named by a string (`query_to_xml`,
    `table_to_xml`, `ts_stat`, `crosstab`, `dblink`, … in `SQL_TEXT_FUNCTIONS`);
  - names that would make the tokeniser and Postgres read the same text differently
    (`standard_conforming_strings`, `backslash_quote`, `set_config`), statistics views
    holding sampled row values of every table (`pg_stats`, `pg_statistic`, …), and the
    kernel's notification channels (`LISTEN`, `NOTIFY`, `pg_notify`), in
    `REFUSED_SQL_NAMES`;
  - a query whose text is not a string, and a submittable (`submit`): `pg` hands it the
    raw connection.
- **The checked text runs.** A query config is copied once into a frozen plain object
  (`text`, `values`, `name`, `rowMode`, `types`), and `pg` gets the copy. A getter cannot
  answer the guard one text and `pg` another.
- **Hidden members.** A guarded pool hides its listeners (`on`, `once`, `addListener`, …),
  `options`, `Client`, `constructor` and every `_`-prefixed internal. A guarded client hides
  its listeners, `connection`, `connectionParameters`, `password`, `constructor` and its `_`
  internals. A `get` throws `PoolLifecycleError`. Reflection sees no descriptor, no `in`,
  no key. Writes, definitions and deletes of any member throw.

### Consequences

- 🟢 **Good:** A plugin's SQL on the borrowed pool no longer reads the graph, memory, user
  or audit tables. The canary sweep probes the guarded pool on Neon
  (`sweepPluginGraphPool`), with the raw pool as positive control.
- 🟢 **Good:** channel-teams and dev-platform need no release.
- 🔴 **Bad (false refusals):** A plugin column or alias that shares a kernel table's name
  (`users`, `tasks`, `skills`, …) refuses its statement. The fix is a rename in the plugin.
- 🔴 **Bad (residual, containment):** Plugins run in the kernel's process. The guard keeps
  a plugin's SQL on the borrowed pool to its own tables. It does not contain a hostile
  upload: such a plugin can read the connection string from the process environment and
  open its own pool. Containing that needs process isolation (the sandbox of ADR-0017) or
  B, not a better guard. The operator's grant remains the bound for uploads.
- 🔴 **Bad (residual):** The guard reads names, not meaning.
  - A kernel function not created by a migration, or an extension function that runs SQL
    text and is missing from `SQL_TEXT_FUNCTIONS`, is not caught.
  - Catalog views other than the statistics views (`pg_stat_activity`,
    `information_schema`) stay readable. They show metadata and statement text with
    `$n` placeholders, not row values.
  - The plugin-owned rows are keyed by id, which is not a credential (#789).
  - B (#2088) remains the stronger form for a plugin that needs more than a few tables.
- ⚪ **Neutral:** A new kernel table needs one line in `kernelSqlRelations.ts`; the test
  says which.

## Pros and Cons of the Options

### A — Deny list on the borrowed pool

- 🟢 No plugin release; small, reviewable code; fails closed.
- 🔴 Name-based: false refusals on shared names, residuals above.

### B — `ctx.sql` with an own schema

- 🟢 Enforced by Postgres roles, not by the kernel's reading of SQL.
- 🔴 Needs a data migration in both plugins and a release each.

### C — Pass through

- 🟢 No code.
- 🔴 The read past the boundary stays open.

## More Information

- Code: `middleware/src/platform/sqlTableGuard.ts`, `kernelSqlRelations.ts`,
  `borrowedPool.ts`, `pluginContext.ts`.
- Tests: `test/sqlTableGuard.test.ts`, `test/kernelSqlRelations.test.ts`,
  `test/borrowedPool.test.ts`, `test/memoryAccess/canarySweepSuite.ts` (graphPool probe).
- Related: [ADR-0039](0039-memory-access-verified-by-oracle-and-canary-sweep.md),
  [ADR-0040](0040-one-graph-read-boundary-per-turn.md),
  [ADR-0166](0166-archetype-plugin-database-roles-are-opt-in.md).
