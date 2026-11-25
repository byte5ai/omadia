# 0050 — Plugin database access: declared, operator-granted, and migrated by the kernel's one runner

## Status

Accepted

- **Date:** 2026-11-25
- **Deciders:** omadia maintainers (recorded retroactively from the code on main); epic #470 items C7/G4 (SQL permission, shared runner), C9 (#796, core schema), C11/C15 (migration handoff), C16 (#817, consent route), #794 (bundled ramp)
- **Supersedes:** —

## Context and Problem Statement

Some plugins own tables. They reached Postgres through the capability `graphPool`, which is
not a service another plugin offers but the operator's own connection pool, the one the
kernel writes user data through. After the service gate
([ADR-0053](0053-service-access-by-declaration-one-provider-per-capability.md)) a `requires:` line was
enough to get it, and a `requires:` line is the plugin author's own statement. Each plugin
also carried its own copy of a migration loop, and the kernel's migrators had already
shown what that costs: two replicas booting together both read an empty ledger and both
applied the files. This record is written retroactively; the decision is implemented on
main. [ADR-0015](0015-agent-archetypes-and-archetype-plugins.md) decides the stricter
case of archetype plugins (own schema and roles); this record covers the general rule.

When may a plugin touch the database, and who runs its schema changes?

## Decision Drivers

- The operator's database is handed over by the operator, not by the plugin's manifest.
- A plugin must not be able to take the shared pool down for everyone.
- Schema changes must be safe under several replicas and need no per-plugin code.
- Moving a subsystem out of the kernel into a plugin must not re-run or skip its history
  silently.
- The kernel's own schema must never depend on a plugin activating.

## Considered Options

- **A — Declaration plus operator grant; a guarded pool; one kernel-run migration runner**
- **B — `requires: graphPool` is enough**, each plugin migrates itself
- **C — A separate database or schema with its own role for every plugin**

## Decision Outcome

Chosen option: **A** (and C for archetype plugins, per ADR-0015).

- **Three things must hold for a pool-shaped capability** (`POOL_SHAPED_CAPABILITIES`,
  today `graphPool`): `requires: graphPool@^1`, a `permissions.sql` block in the manifest,
  and an operator grant row in `plugin_sql_grants` (migration 0047). A missing one throws
  `SqlPermissionError` with the reason `undeclared` (the author's to fix) or `ungranted`
  (the operator's). `ctx.sql` exists only when declaration and grant are both present.
- **Consent has one route.** `GET`/`PUT /installed/:id/grants` answers for the SQL grant
  and the public-path grant together; the ledger name comes from the manifest and
  `granted_by` from the session, never from the request body. A grant takes effect
  without a restart.
- **The ledger name is the only plugin string that reaches SQL as an identifier.** It must
  match `^[a-z][a-z0-9_]{2,62}$` and sit in the kernel-owned namespace
  `plg_<folded plugin id>_…`; exclusive ownership is `UNIQUE (ledger)` in the grant table.
- **The pool is borrowed.** `borrowPool` passes `query` and `connect` through and throws
  `PoolLifecycleError` on `end` and `removeAllListeners`; a client from `connect()` is
  wrapped as well. Arbitrary SQL by a granted plugin is the consented behaviour.
- **One runner, run by the kernel before `activate()`** (`runPluginMigrations`): the whole
  batch in one transaction under `pg_advisory_xact_lock` in namespace 4420 (the kernel's
  migrators use 4410), `lock_timeout` 2 s, `statement_timeout` 30 s per statement,
  checksums in the ledger. "The tables exist" is an invariant `activate()` may rely on.
- **Migration handoff is declared, and the witness decides.** A plugin that takes over
  files a kernel ledger already applied names a JSON plan in `permissions.sql.handoff`
  (at most 128 KB, validated before any plugin code runs). A file is seeded as applied
  only when its witness query finds the schema object in the live catalog; the donor
  ledger is corroboration and its rows are never deleted. A file without a witness is not
  seeded and the runner applies it.
- **The kernel's schema is the kernel's.** `coreMigrations.ts` applies it at boot from
  `DATABASE_URL` on a short-lived pool of its own, before any plugin activates, and
  retries only lock contention.
- **Bundled plugins have a dated ramp** (`LEGACY_SQL_GRANTS_2026_08_20`), consulted only
  for catalog origin `bundled`.

### Consequences

- 🟢 **Good:** The install dialog can show that a plugin wants schema, and the grant is a
  recorded decision of a named operator.
- 🟢 **Good:** Plugin migrations are serialized and all-or-nothing without any plugin code.
- 🔴 **Bad:** A granted plugin still holds the shared pool and can read and write kernel
  tables; only archetype plugins are confined to a schema (ADR-0015). Plugin code runs in
  the kernel's process, so this is a rule for the connection the kernel hands out, not a
  boundary against hostile code.
- 🔴 **Bad:** A migration batch has 30 s per statement and runs on the boot path; a slow
  backfill blocks that plugin's activation.
- 🔴 **Bad:** Without a database there is no grant store, so the consent endpoints answer
  503 and SQL-owning plugins cannot be granted.
- ⚪ **Neutral:** Transaction-scoped locks only, in line with
  [ADR-0034](0034-no-session-state-behind-a-transaction-pooler.md).

## Pros and Cons of the Options

### A — Declaration, grant, guarded pool, one runner

- 🟢 Consent is explicit; the race is fixed once for all plugins.
- 🔴 No isolation between a granted plugin and kernel tables.

### B — `requires:` only, self-run migrations

- 🟢 Nothing to build.
- 🔴 The author consents on the operator's behalf; every plugin re-creates the boot race.

### C — Own schema and role for every plugin

- 🟢 Real isolation at the database.
- 🔴 Existing plugins keep their tables in `public`; moving them is a data migration per
  plugin. Chosen only where the plugin opts in (kind `archetype` without `graphPool`).

## More Information

- Related: [ADR-0015](0015-agent-archetypes-and-archetype-plugins.md),
  [ADR-0034](0034-no-session-state-behind-a-transaction-pooler.md),
  [ADR-0052](0052-plugin-routes-auth-modes-and-public-path-grants.md) (the other operator grant).
- Paths: `middleware/src/platform/pluginSqlGrants.ts`, `pluginSqlGrantStore.ts`,
  `borrowedPool.ts`, `pluginMigrations.ts`, `pluginMigrationHandoff.ts`,
  `pluginHandoffPlan.ts`, `coreMigrations.ts`, `archetypeDatabase.ts`;
  `middleware/src/routes/runtimeGrants.ts`; `middleware/migrations/0047_plugin_sql_grants.sql`.
- Tests: `middleware/test/pluginSqlPermission.test.ts`, `borrowedPool.test.ts`,
  `pluginMigrations.pg.test.ts`, `pluginMigrationHandoff.pg.test.ts`,
  `pluginHandoffPlan.test.ts`, `bundledPluginSqlGateBoot.pg.test.ts`,
  `archetypeDatabase.pg.test.ts`.
