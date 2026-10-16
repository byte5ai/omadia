-- #330 follow-up — durable per-run state for ephemeral (agent-generated) runs.
--
-- Incident 2026-10-15: a facilitation's progress log, nudge counter and
-- conversation link lived only in the Facilitator plugin's in-memory store. A
-- deploy restarted the middleware, the store was gone, and the durable run
-- kept ticking hourly against "no active facilitation known". This table is
-- the plugin's working memory for ONE run, written through the owner-guarded
-- `conductorEphemeralRuns.saveRunState` seam and read back by `listOwnRuns`.
--
-- Keyed by run_id, not workflow_id: the state belongs to the run (one blob per
-- run, last write wins), and the FK cascades so a hard-deleted run can never
-- leave a dangling row. Ownership is NOT trusted from agent_id — every write
-- re-derives it from conductor_workflows.created_by_agent in the same
-- statement; agent_id is a denormalized index/audit column.
--
-- Lifetime: purged together with the reap (ConductorEphemeralStore.markReaped
-- deletes the rows in the same statement that stamps reaped_at). It is plugin
-- working memory, not audit trace — the run's steps/context stay the minutes.
-- The size CHECK mirrors MAX_RUN_STATE_BYTES in ephemeralRunService.ts.
-- Idempotent per the 0009/0010 pattern (CI re-applies every file).

CREATE TABLE IF NOT EXISTS conductor_ephemeral_run_state (
  run_id     UUID PRIMARY KEY REFERENCES conductor_runs(id) ON DELETE CASCADE,
  agent_id   TEXT NOT NULL,
  state      JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ops/audit lookups by agent ("what state does agent X hold"); the hot paths join on run_id.
CREATE INDEX IF NOT EXISTS conductor_ephemeral_run_state_agent_idx
  ON conductor_ephemeral_run_state (agent_id);

ALTER TABLE conductor_ephemeral_run_state DROP CONSTRAINT IF EXISTS conductor_ephemeral_run_state_size_check;
ALTER TABLE conductor_ephemeral_run_state ADD CONSTRAINT conductor_ephemeral_run_state_size_check
  CHECK (octet_length(state::text) <= 16384);
