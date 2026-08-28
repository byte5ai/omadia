-- #759 — operator run cancellation.
--
-- Adds the terminal run status 'cancelled' (the awaits table has carried the
-- value since 0001 — no code path ever wrote it) plus the cancel-request
-- columns the executor checks between steps: a running drive cannot be killed
-- mid-step (the at-least-once effect window stays bounded to one step, same
-- as crash recovery), so cancellation of a 'running' run is a flag the driver
-- honours at the next step boundary, while a 'waiting' run cancels
-- immediately (its awaits close as 'cancelled').

ALTER TABLE conductor_runs DROP CONSTRAINT IF EXISTS conductor_runs_status_check;
ALTER TABLE conductor_runs ADD CONSTRAINT conductor_runs_status_check
  CHECK (status IN ('running', 'waiting', 'completed', 'failed', 'cancelled'));

ALTER TABLE conductor_runs ADD COLUMN IF NOT EXISTS cancel_requested_by TEXT;
ALTER TABLE conductor_runs ADD COLUMN IF NOT EXISTS cancel_requested_at TIMESTAMPTZ;
