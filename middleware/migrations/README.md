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

The migration runner and its applied-migrations bookkeeping table are
introduced with the multi-orchestrator runtime config tables — see
`specs/001-multi-orchestrator-runtime/tasks.md` task T027 (US4). Until
then this directory holds the convention only.
