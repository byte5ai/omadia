-- Spec 2042 §5.10 (#2053, S3): operator jobs and maintenance runs of the
-- model gateway.
--
-- Every model call runs in an execution context. Two of them are not an
-- agent's: an OPERATOR JOB (an admin function an operator starts explicitly,
-- e.g. the issue preview, a skill verification, topic regrouping, bulk
-- promotion, a builder's chat) and a MAINTENANCE RUN (a job that keeps an
-- index current, e.g. the embedding backfill; it only embeds). Each run has a
-- budget of model calls, a deadline and, for operator jobs, a cancel. This
-- table is their record: who started what, what it may do, what it used and
-- how it ended. The instance's daily operator-tools and maintenance budgets
-- are summed from it.

CREATE TABLE IF NOT EXISTS model_work_runs (
  id              UUID PRIMARY KEY,
  context_kind    TEXT NOT NULL CHECK (context_kind IN ('operator_job', 'maintenance_run')),
  -- What the run is, e.g. 'issue_preview', 'embedding_backfill'.
  job_kind        TEXT NOT NULL CHECK (length(job_kind) BETWEEN 1 AND 100),
  -- The operator who started an operator job (user id or email); NULL for a
  -- maintenance run, which the kernel starts.
  started_by      TEXT,
  -- What the job declares it may change, e.g. {'topics'}. Shown with the job.
  effects         TEXT[] NOT NULL DEFAULT '{}',
  budget_calls    INTEGER NOT NULL CHECK (budget_calls > 0),
  model_calls     INTEGER NOT NULL DEFAULT 0 CHECK (model_calls >= 0),
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deadline_at     TIMESTAMPTZ NOT NULL,
  ended_at        TIMESTAMPTZ,
  status          TEXT NOT NULL DEFAULT 'running'
                  CHECK (status IN ('running', 'succeeded', 'failed', 'cancelled', 'budget_exhausted', 'deadline')),
  cancelled_by    TEXT,
  message         TEXT
);

-- The daily budgets sum today's runs of one context; the admin list shows the
-- newest first.
CREATE INDEX IF NOT EXISTS model_work_runs_context_started
  ON model_work_runs (context_kind, started_at DESC);
