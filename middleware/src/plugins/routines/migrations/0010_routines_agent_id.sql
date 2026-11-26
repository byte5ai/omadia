-- #1745 — a routine is bound to the agent that created it by id, not only by
-- slug: a new agent that takes over a deleted agent's slug does not take over
-- its routines. NULL (rows from before this migration) is bound on the next
-- run whose slug still names an enabled agent.

ALTER TABLE routines
  ADD COLUMN IF NOT EXISTS agent_id TEXT NULL;

CREATE INDEX IF NOT EXISTS idx_routines_agent
  ON routines (agent_id, agent_slug) WHERE status = 'active';

COMMENT ON COLUMN routines.agent_id IS
  '#1745 — id of the agent that runs the routine; NULL = bound on its next run.';
