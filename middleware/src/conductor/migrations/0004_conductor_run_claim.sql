-- Conductor — run-resume claim/lease columns (US2 durability tail / SC-002).
-- A run is driven in-process; a process restart leaves its 'running' row orphaned
-- (nothing re-drives it). The run-resume worker claims stale 'running' rows and
-- re-drives them from current_step_id. claimed_by is a per-drive LEASE token: every
-- step write is fenced on `WHERE claimed_by = <my lease>`, so a driver that has been
-- superseded by a worker steal aborts on its next write instead of double-driving.
-- A live drive heartbeats claimed_at every step, so a row is "stale" only when its
-- owning process has gone away. Forward-only, idempotent.
ALTER TABLE conductor_runs ADD COLUMN IF NOT EXISTS claimed_by UUID;
ALTER TABLE conductor_runs ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;

-- The claim scan filters status='running' AND is_dry_run=false, ranges on claimed_at,
-- and orders by started_at — cover all of it in one partial index.
CREATE INDEX IF NOT EXISTS conductor_runs_running_idx
  ON conductor_runs(claimed_at, started_at)
  WHERE status = 'running' AND is_dry_run = false;

-- Make re-opening a human await idempotent: if a crash between awaitStore.create()
-- and runStore.park() leaves a run 'running' at a human step, the resume re-drive must
-- not open a SECOND await for the same (run, step). One open await per step, enforced.
CREATE UNIQUE INDEX IF NOT EXISTS conductor_awaits_open_uniq
  ON conductor_awaits(run_id, step_id)
  WHERE status = 'waiting';
