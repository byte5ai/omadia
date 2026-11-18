-- #1598 — the orchestrator a routine belongs to.
--
-- A routine used to run on the legacy `chatAgent@1` bundle, which carries no
-- per-Agent plugin grants and therefore every plugin's tools. A channel user
-- whose orchestrator lacks a plugin could schedule a routine that used it.
-- The slug of the orchestrator that handled the creating turn is stored here
-- and the run resolves that orchestrator from the registry. NULL (routines
-- created before this migration, or on the legacy bundle) runs on the
-- platform's standard (fallback) orchestrator, which has grants too.

ALTER TABLE routines
  ADD COLUMN IF NOT EXISTS agent_slug TEXT NULL;

COMMENT ON COLUMN routines.agent_slug IS
  '#1598 — slug of the orchestrator that created the routine; the run uses it. NULL = standard orchestrator.';
