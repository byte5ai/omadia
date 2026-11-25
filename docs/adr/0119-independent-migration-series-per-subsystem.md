# 0119 — Schema changes are forward-only SQL files in independent series, applied at boot

## Status

Accepted

- **Date:** 2026-11-25
- **Deciders:** omadia maintainers (recorded retroactively); plugin runner in #787 (epic #470
  C7/G4), core schema applied by core in #796, legacy graph directory pinned in #875. Locking
  is [ADR-0034](0034-no-session-state-behind-a-transaction-pooler.md).
- **Supersedes:** —

## Context and Problem Statement

This record is retroactive. The middleware has no migration framework and no operator-run
migration step: a version bump must also migrate, on one machine or on several booting at once.
Subsystems (auth, conductor, knowledge graph, memory store, routines, profiles) are developed
and extracted independently, and plugins bring tables of their own. Where does a schema change
go, who applies it, and what must every migration file satisfy?

## Decision Drivers

- A one-click update and a Fly deploy must leave no manual step.
- A subsystem's schema must not depend on another subsystem's numbering or activation.
- Plugin authors must not copy a migrator (each copy repeated the same concurrency bug).
- CI must catch a broken SQL file before a deploy does.

## Considered Options

- **A — One series per subsystem with its own ledger table, applied by its owner at boot; one
  shared runner for plugin-owned schema.**
- **B — One global series and one ledger** for the whole repository.
- **C — A migration tool** (Prisma, Knex, Flyway) with generated or operator-applied migrations.

## Decision Outcome

Chosen option: **A**.

- **Eight kernel series, eight ledgers.** `middleware/migrations`
  (`_multi_orchestrator_migrations`, the core series), `src/auth/migrations`
  (`_auth_migrations`), `src/conductor/migrations` (`_conductor_migrations`),
  `src/plugins/routines/migrations` (`_routine_migrations`), `src/profileStorage/migrations`,
  `src/profileSnapshots/migrations`, `harness-knowledge-graph-neon/src/migrations`
  (`_graph_migrations`) and `harness-memory-postgres/src/migrations` (`_memory_migrations`).
  A new table goes into the series of the subsystem that owns it; numbering is per series.
- **File rules.** `NNNN_short_description.sql`, plain SQL, forward-only, never edited after
  release. The ledger key is the file name and files apply in lexical order, so the number is
  an ordering hint, not an identity (the core series has gaps and two files each numbered 0040
  and 0053).
- **Every file must be applicable twice.** The CI job `schema` applies all eight series to
  `pgvector/pgvector:pg16` and then applies them again. Constraints are therefore added inside
  guarded `DO` blocks, columns with `IF NOT EXISTS`.
- **Applied at boot by the owner.** Each migrator reads its ledger, and only when files are
  pending applies each one in its own transaction under `pg_advisory_xact_lock(4410,
  hashtext(<ledger>))` with a 2 s `lock_timeout`, re-reading the ledger under the lock
  (ADR-0034). A lock timeout with work still owed fails the boot with "timed out", which the
  plugin retry treats as transient.
- **Core's schema does not wait for a plugin.** `platform/coreMigrations.ts` applies the core
  series from `DATABASE_URL` on a short-lived pool before any tool plugin activates (#796);
  the orchestrator's later call is a no-op.
- **Plugins use the kernel's runner.** `ctx.sql.runMigrations()` (`platform/pluginMigrations.ts`)
  gives a plugin locking, ledger, checksums and ordering: namespace 4420 (separate from core's
  4410), one transaction for the whole batch, checksum drift on an applied file is an error.
  The ledger name is declared in the manifest (`permissions.sql.ledger`).
- **Moving a series into a plugin** seeds the plugin ledger per file from a catalog witness,
  never from the donor ledger alone (`platform/pluginMigrationHandoff.ts`).
- **A directory no migrator reads stays inert.** `src/services/graph/migrations` may hold only
  byte-identical copies of knowledge-graph files; CI fails otherwise.

### Consequences

- 🟢 **Good:** Deploying is migrating; two replicas booting together apply each file once.
- 🟢 **Good:** A subsystem can be extracted with its series and ledger.
- 🔴 **Bad:** No down migrations; a rollback of the image meets a newer schema.
- 🔴 **Bad:** Eight near-identical migrator files; a fix (as for ADR-0034) is made eight times.
- 🔴 **Bad:** Kernel files carry no checksum, so an edited applied file goes unnoticed; only
  plugin migrations are checked.
- ⚪ **Neutral:** Exceptions exist: `memory_purge_audit` is created by its service
  (`services/memoryPurgeAudit.ts`), not by a series, and `@omadia/memory-postgres` still runs
  its own migrator although its manifest reserves a kernel ledger name. The header of
  `pluginMigrations.ts` still describes the core migrators as session-locked, which ADR-0034
  ended. `middleware/migrations/README.md` lists five of the seven other series.

## Pros and Cons of the Options

### A — Independent series, boot-applied

- 🟢 Ownership is local; no cross-series ordering except the explicit list in CI.
- 🔴 Duplication; where one series depends on another, the order exists only as the list in CI.

### B — One global series

- 🟢 One ledger, one order.
- 🔴 Extracting a subsystem into a plugin splits history; numbering conflicts between parallel
  PRs across all subsystems.

### C — Migration tool

- 🟢 Checksums, tooling, down migrations.
- 🔴 A build or operator step; raw SQL with pgvector and guarded DDL is what the files need.

## More Information

- Code: the eight `migrator.ts` files, `middleware/src/platform/{coreMigrations,
  pluginMigrations,pluginMigrationHandoff}.ts`, `.github/workflows/ci.yml` (job `schema`,
  `MIGRATION_DOMAINS`), `middleware/migrations/README.md`, `AGENTS.md` (new migration rule).
- Tests: `migratorConcurrentBoot.test.ts`, `migratorXactLock.pg.test.ts`,
  `coreMigrations.pg.test.ts`, `pluginMigrations.pg.test.ts`, `pluginMigrationHandoff.pg.test.ts`.
- Related: ADR-0034, [ADR-0035](0035-postgres-tests-are-found-by-name-and-held-by-a-floor.md),
  ADR-0022 (plugin database roles). Border: plugin platform (plugin-owned schema).
