-- #1843 — who created a stored process.
--
-- A process can hold personal data in its title and steps, and an erasure
-- request (memory purge, axis "User") must find the processes the person
-- created. `write_process` stamps the turn's canonical omadia user id; NULL
-- for processes stored before this migration and for writes without a known
-- user (their creator is unknown, so no user purge selects them).
--
-- Idempotent: IF NOT EXISTS, so a re-run or a partially applied deploy is a
-- no-op.

ALTER TABLE processes
  ADD COLUMN IF NOT EXISTS created_by_omadia_user_id TEXT NULL;

CREATE INDEX IF NOT EXISTS idx_processes_created_by
  ON processes (tenant_id, created_by_omadia_user_id)
  WHERE created_by_omadia_user_id IS NOT NULL;
