-- #1760 — a run whose agent answered that nothing is worth telling
-- (`[[nothing]]`, as for agent triggers) ends `silent`: successful, nothing
-- delivered. Before, a templated routine could never stay silent and an empty
-- answer failed the run.

ALTER TABLE routine_runs DROP CONSTRAINT IF EXISTS routine_runs_status_chk;
ALTER TABLE routine_runs
  ADD CONSTRAINT routine_runs_status_chk
  CHECK (status IN ('ok', 'error', 'timeout', 'cancelled', 'silent'));

ALTER TABLE routines DROP CONSTRAINT IF EXISTS routines_last_run_status_chk;
ALTER TABLE routines
  ADD CONSTRAINT routines_last_run_status_chk
  CHECK (last_run_status IS NULL
         OR last_run_status IN ('ok', 'error', 'timeout', 'cancelled', 'silent'));
