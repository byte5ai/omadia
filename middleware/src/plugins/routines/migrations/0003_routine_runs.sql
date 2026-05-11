-- 0003_routine_runs.sql
-- Per-run history with full agentic trace for the Operator-UI run-detail
-- viewer. Until now the `routines` row carried only `last_run_*` columns,
-- which means a failed run loses every previous outcome and there is no
-- tool-loop trace to debug a frozen turn. This table is append-only:
-- one row per scheduled or manual trigger.
--
-- Access pattern:
--   - write at end of every triggered run (success/error/timeout)
--   - read by (routine_id, started_at DESC) for the per-routine history
--     panel in the Operator-UI (last 10 / 50)
--   - read by (id) for the single-run detail page that renders the
--     run-trace JSON (collapsible call-stack viewer)
--
-- Design notes:
--   - id is UUID so the API path /routines/:id/runs/:runId stays opaque.
--   - routine_id has ON DELETE CASCADE: deleting a routine purges its
--     run history too. Run history outliving the parent row would create
--     orphan rows that cannot be navigated to from the UI.
--   - tenant + user_id are denormalised so per-user list queries don't
--     need to join `routines` (and so retention jobs can scope by tenant
--     without a join either).
--   - run_trace is JSONB so we can query into it later (e.g. count
--     tool calls per agent) without parsing every row into the app layer.
--     v1 just stores it as-is; no GIN index yet (read pattern is
--     point-lookup by run id, not full-text on trace contents).
--   - trigger captures whether the run came from cron, catch-up after a
--     deploy, or a manual operator/agent-initiated invocation. This lets
--     the UI badge the row and helps debug "why did this routine fire
--     twice in 30s after a deploy".

CREATE TABLE IF NOT EXISTS routine_runs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  routine_id    UUID NOT NULL REFERENCES routines(id) ON DELETE CASCADE,
  tenant        TEXT NOT NULL,
  user_id       TEXT NOT NULL,
  trigger       TEXT NOT NULL DEFAULT 'cron',
  started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at   TIMESTAMPTZ NULL,
  duration_ms   INTEGER NULL,
  status        TEXT NOT NULL,
  error_message TEXT NULL,
  prompt        TEXT NOT NULL,
  answer        TEXT NULL,
  iterations    INTEGER NULL,
  tool_calls    INTEGER NULL,
  run_trace     JSONB NULL,
  CONSTRAINT routine_runs_status_chk
    CHECK (status IN ('ok', 'error', 'timeout')),
  CONSTRAINT routine_runs_trigger_chk
    CHECK (trigger IN ('cron', 'catchup', 'manual'))
);

-- Primary read path: list a routine's runs newest first for the
-- per-routine history panel.
CREATE INDEX IF NOT EXISTS idx_routine_runs_routine
  ON routine_runs (routine_id, started_at DESC);

-- Per-user activity feed (e.g. "show every run for routines I own").
CREATE INDEX IF NOT EXISTS idx_routine_runs_user
  ON routine_runs (tenant, user_id, started_at DESC);
