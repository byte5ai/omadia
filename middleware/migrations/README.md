# Database Migrations

Forward-only SQL migrations for the Omadia middleware (Neon Postgres).

## Convention

- One file per migration: `NNNN_short_description.sql`, where `NNNN` is
  a zero-padded, strictly increasing integer (`0001_…`, `0002_…`).
- Migrations are **append-only and forward-only** — never edit a file
  that has already been applied; add a new migration instead.
- Each file is a self-contained SQL script applied inside a
  transaction; make statements idempotent where practical.
- Files are applied in filename order.

## Runner

`runMultiOrchestratorMigrations` in
`middleware/packages/harness-orchestrator/src/registry/migrator.ts` applies
this directory, and the harness-orchestrator plugin calls it during activation
— so these migrations run automatically at boot, they are not operator-applied.
The Docker image gets the directory via `COPY middleware/migrations ./migrations`
(tsc does not bundle `.sql`), which is the path the runner's
`defaultMigrationsDir()` resolves to.

> This section previously said the runner was still to come with
> `specs/001-multi-orchestrator-runtime` task T027. It landed; the note was
> stale, and #432 depended on knowing which way round it is — an operator-facing
> one-click update needs to know whether a version bump also migrates.

Other subsystems keep their own independent series with their own runners and
bookkeeping tables (`auth/migrations`, `conductor/migrations`,
`plugins/routines/migrations`, `profileStorage/migrations`,
`profileSnapshots/migrations`), so numbering here is independent of theirs.
