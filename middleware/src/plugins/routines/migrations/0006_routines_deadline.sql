-- #2082 — routines are user-requested triggers (spec 2042 §5.12).
--
-- A routine keeps its human owner, its controls and its cron semantics, and
-- now gets a deadline like every trigger: `until`. Before it ends the owner is
-- asked once whether it should go on (`renewal_asked_at`); renewing moves the
-- deadline. A routine past its deadline is paused with a last_run_error that
-- says so; resuming or renewing it starts a new period.
--
-- NULL `until` (rows from before this migration) gets a fresh deadline the
-- first time the kernel schedules the routine.

ALTER TABLE routines
  ADD COLUMN IF NOT EXISTS until TIMESTAMPTZ NULL;

ALTER TABLE routines
  ADD COLUMN IF NOT EXISTS renewal_asked_at TIMESTAMPTZ NULL;

COMMENT ON COLUMN routines.until IS
  '#2082 — deadline of the routine''s trigger; renewing moves it. NULL = not scheduled since the migration.';
