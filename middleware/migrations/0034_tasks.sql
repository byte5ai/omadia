-- Issue #560 — durable backing for the generic long-running task seam
-- (`@omadia/orchestrator`'s `TaskStore`). InMemoryTaskStore is process-local, so
-- every long-running task is lost on restart and `<tool>_status` then answers
-- "not found"; this table is the durable second implementor (see
-- src/tasks/durableTaskStore.ts). Claim/lease columns mirror dev_jobs and
-- conductor_runs (migrations 0022 / src/conductor/migrations/0004). Forward-only,
-- idempotent.
--
-- A CHECK on `status` IS appropriate here, unlike dev_jobs (whose comment warns a
-- CHECK on a growing enum is a liability): the seam's lifecycle vocabulary is a
-- deliberately CLOSED four-value set chosen to project onto MCP Tasks
-- (TASK_LIFECYCLE_STATUSES in taskTypes.ts), not a growing pipeline enum. A new
-- value would be a seam redesign, and having the constraint fail the write is the
-- point.
CREATE TABLE IF NOT EXISTS tasks (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind               TEXT NOT NULL,                             -- implementor subtype, e.g. 'subagent.hr'
  status             TEXT NOT NULL DEFAULT 'working'
                       CHECK (status IN ('working','input_required','completed','failed')),
  phase              TEXT NOT NULL DEFAULT 'queued',            -- implementor progress label
  input              JSONB NOT NULL,                            -- the opaque payload the executor is claimed with
  claimed_by         UUID,                                      -- lease token; MUST be a UUID (randomUUID())
  claimed_at         TIMESTAMPTZ,
  last_heartbeat_at  TIMESTAMPTZ,
  result             TEXT,                                      -- populated on 'completed'
  error              TEXT,                                      -- populated on 'failed'
  created_by         TEXT,                                      -- owner for read scoping; NULL = unscoped
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at           TIMESTAMPTZ                                -- set exactly when status is terminal
);

-- Claim scan: oldest UNCLAIMED working task, optionally by kind / by exact id.
-- Covers the `FOR UPDATE SKIP LOCKED` pop and the resume driver's no-hint claim.
CREATE INDEX IF NOT EXISTS tasks_claimable_idx
  ON tasks(created_at) WHERE status = 'working' AND claimed_by IS NULL;

-- Reaper: a live task's "last sign of life" for the abandoned-worker sweep.
CREATE INDEX IF NOT EXISTS tasks_live_idx
  ON tasks(last_heartbeat_at) WHERE status = 'working';

-- `_list` / `_status` scope reads to the caller.
CREATE INDEX IF NOT EXISTS tasks_created_by_idx ON tasks(created_by, created_at DESC);

CREATE TABLE IF NOT EXISTS task_events (
  task_id  UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  seq      BIGINT NOT NULL,                                     -- monotonic WITHIN a task, starts at 1
  ts       TIMESTAMPTZ NOT NULL DEFAULT now(),
  type     TEXT NOT NULL,
  message  TEXT NOT NULL,
  PRIMARY KEY (task_id, seq)
);
