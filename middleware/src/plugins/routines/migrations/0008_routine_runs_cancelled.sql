-- #1746 — a run whose routine was paused or deleted while it ran is recorded
-- as `cancelled`, not as `timeout`: the routine did not time out, and an
-- operator who reads `timeout` would raise `timeoutMs`, which does not help.

ALTER TABLE routine_runs DROP CONSTRAINT IF EXISTS routine_runs_status_chk;
ALTER TABLE routine_runs
  ADD CONSTRAINT routine_runs_status_chk
  CHECK (status IN ('ok', 'error', 'timeout', 'cancelled'));

ALTER TABLE routines DROP CONSTRAINT IF EXISTS routines_last_run_status_chk;
ALTER TABLE routines
  ADD CONSTRAINT routines_last_run_status_chk
  CHECK (last_run_status IS NULL
         OR last_run_status IN ('ok', 'error', 'timeout', 'cancelled'));
