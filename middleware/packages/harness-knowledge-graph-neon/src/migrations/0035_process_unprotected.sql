-- #1540 — provenance of a stored process.
--
-- A process written or edited in a turn without a Privacy Shield, or after a
-- tool bypassed it, can carry names and addresses no shield masked in its
-- title and steps. `query_processes` and `run_stored_process` are exempt from
-- interning, and the process recall leg injects titles into the prompt, so
-- under a shield those reads skip a process stored `unprotected`.
--
-- Sticky: an edit from an unprotected turn sets it, an edit from a protected
-- turn keeps it (old steps may survive the edit). FALSE for every process
-- stored before this migration: their provenance is unknown.
--
-- Idempotent: IF NOT EXISTS, so a re-run or a partially applied deploy is a
-- no-op.

ALTER TABLE processes
  ADD COLUMN IF NOT EXISTS unprotected BOOLEAN NOT NULL DEFAULT FALSE;
