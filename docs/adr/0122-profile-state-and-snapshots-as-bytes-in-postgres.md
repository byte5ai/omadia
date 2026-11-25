# 0122 — Profile state and its snapshots are bytes in Postgres; snapshots are immutable and content-addressed

## Status

Accepted

- **Date:** 2026-11-25
- **Deciders:** omadia maintainers (recorded retroactively); Kemia integration phases 2.1.5
  (profile storage), 2.2 (snapshots, OB-64) and 2.3 (drift worker, OB-65). The handoff notes the
  code cites are not in this repository.
- **Supersedes:** —

## Context and Problem Statement

This record is retroactive. A profile bundles an agent's free-form artefacts: the `agent.md`
body and `knowledge/*` files, exported as a ZIP with a manifest. Operators edit the live state,
freeze versions of it, mark one as ready to deploy, and want to know when the live state has
moved away from that version. Where do these bytes live, what is a snapshot, and how is drift
recorded?

## Decision Drivers

- Snapshot metadata and asset bytes must be written together or not at all.
- Several instances share one database but not one disk.
- Re-snapshotting an unchanged profile must not create a duplicate.
- A snapshot is evidence of a released state; it must not change afterwards.

## Considered Options

- **A — Live state and snapshot assets as `BYTEA` rows in Postgres; snapshots immutable and
  unique per content hash; drift in a separate append table.**
- **B — Bytes in the object store**, metadata in Postgres.
- **C — Files on the data volume**, versioned by directory.

## Decision Outcome

Chosen option: **A**.

- **Live state** (`src/profileStorage`, own migration series): `profile_agent_md` and
  `profile_knowledge_file`, each row with `content BYTEA`, `sha256`, `size_bytes`,
  `updated_by`. Knowledge files are flat names. Plugin pins are not mirrored here; they stay in
  the installed registry.
- **Bytes in the database, not S3 or disk.** Bundles are capped at 50 MB
  (`DEFAULT_MAX_BUNDLE_BYTES` in `profileBundleZipper.ts`), which keeps this within what TOAST
  handles; one transaction covers metadata and bytes; no data-directory sync between replicas.
- **Snapshots** (`src/profileSnapshots`, own series): `profile_snapshot` (metadata, manifest,
  `bundle_hash`), `profile_snapshot_asset` (every entry of the bundle ZIP), written atomically
  by `SnapshotService.createSnapshot`, which reuses the bundle zipper.
- **Immutable.** No update of `bundle_hash`, `manifest_yaml` or asset bytes. Only
  `is_deploy_ready` and its audit fields (`deploy_ready_at`, `deploy_ready_by`) change.
- **Idempotent by content.** `UNIQUE (profile_id, bundle_hash)`: the same live state returns
  the existing snapshot (`wasExisting`).
- **Drift is separate and append-only.** `profile_health_score` gets a new row per
  computation, so no immutable row is updated. The drift worker runs daily at 03:00 UTC and on
  demand, compares each profile's deploy-ready snapshot with the live state and stores a score
  between 0 and 1 plus the diverged assets. A profile without a deploy-ready snapshot is
  skipped. One profile's failure does not stop the others (`Promise.allSettled`).

### Consequences

- 🟢 **Good:** A snapshot and its bytes cannot disagree; a rollback target is always complete.
- 🟢 **Good:** No dependency on object storage, which is optional
  ([ADR-0115](0115-binary-objects-in-an-optional-s3-compatible-store.md)).
- 🔴 **Bad:** Up to 50 MB per snapshot in Postgres; `src/profileSnapshots` has no retention
  job, so storage grows with every distinct state.
- 🔴 **Bad:** `is_deploy_ready` is a boolean; states such as archived or rolled back would need
  a schema change (noted in the migration).
- ⚪ **Neutral:** The whole subsystem needs Postgres; both series run on the graph plugin's pool
  (`graphPool`) at boot, so an install without it has no profile storage. `profile_health_score` rows accumulate one per profile per day.

## Pros and Cons of the Options

### A — BYTEA in Postgres, immutable, content-addressed

- 🟢 Transactional, replica-safe, simple diff reads.
- 🔴 Large rows in the primary database.

### B — Object store

- 🟢 Cheap bytes.
- 🔴 No transaction across both stores; 90-day expiry there contradicts permanent snapshots; a
  round trip per asset when diffing.

### C — Data volume

- 🟢 No database growth.
- 🔴 Not shared between replicas; no atomic write with the metadata.

## More Information

- Code: `middleware/src/profileStorage/{liveProfileStorageService,migrator}.ts`,
  `middleware/src/profileSnapshots/{snapshotService,driftWorker,healthScore,migrator}.ts`, both
  `migrations/` directories, `middleware/src/plugins/profileBundleZipper.ts`.
- Tests: `middleware/test/profileSnapshots.test.ts`.
- Related: [ADR-0119](0119-independent-migration-series-per-subsystem.md). Border: profiles / plugin bundles.
