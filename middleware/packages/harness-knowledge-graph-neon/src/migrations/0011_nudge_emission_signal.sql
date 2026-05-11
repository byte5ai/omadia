-- Palaia-Integration · Phase 8 (OB-77) — Forward-fix for migration 0010.
--
-- Production deployments that picked up 0010 BEFORE the success_signal
-- column landed (column was added to 0010 mid-Slice-2 but the file was
-- already applied on long-running dev DBs) need a forward-only ADD
-- COLUMN — the migrator never re-runs an already-applied file.
--
-- IF NOT EXISTS makes this idempotent: fresh DBs that pick up the
-- amended 0010 already have the column; this no-ops cleanly. Cleaner
-- DBs created from snapshots after this commit will see both 0010 and
-- 0011 in `_graph_migrations` — no functional difference, just an
-- extra audit row.

ALTER TABLE nudge_emissions
  ADD COLUMN IF NOT EXISTS success_signal_json JSONB NULL;
