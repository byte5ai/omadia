-- Epic #470 W2 — phased pipeline + GitHub App credential mode.
-- Renumbered 0022 → 0023: W0's migration already took 0022 (the spec was written
-- against the pre-renumber plan). Forward-only, idempotent.
--
-- No CHECK on the growing enums (`dev_job_events.type`, `dev_job_artifacts.kind`):
-- W0 dropped them deliberately because every wave adds kinds; W2 adds
-- `bootstrap_report|questions|answers|review_verdict` artifacts and `token|gate|phase`
-- events, validated in src/devplatform/types.ts. A CHECK on a growing enum is a
-- liability. `dev_jobs.phase` is likewise unconstrained (W0 already noted it grows).

-- --- pipeline + review state on the job -----------------------------------
-- `pipeline_mode` gates the human approval: 'gated' (default) opens the plan gate;
-- 'collapsed' skips plan/clarify/await_human and is operator-launch only (enforced
-- at job creation, never for webhook/tracker jobs).
ALTER TABLE dev_jobs
  ADD COLUMN IF NOT EXISTS pipeline_mode text NOT NULL DEFAULT 'gated'
    CHECK (pipeline_mode IN ('gated','collapsed')),
  ADD COLUMN IF NOT EXISTS review_attempt int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS review_fingerprint text,
  -- Whole-job retry lineage: a retry points at the job it re-runs.
  ADD COLUMN IF NOT EXISTS retry_of uuid REFERENCES dev_jobs(id);

-- --- per-repo pipeline configuration ---------------------------------------
ALTER TABLE dev_repos
  -- NULL = the job creator approves; otherwise the named role's live holder set.
  ADD COLUMN IF NOT EXISTS approver_role_key text,
  -- ISO-8601 duration; parsed with runExecutor's parseIsoDurationMs.
  ADD COLUMN IF NOT EXISTS gate_deadline_iso text NOT NULL DEFAULT 'P7D',
  -- NULL = auto-detect from lockfiles; else the exact bootstrap command.
  ADD COLUMN IF NOT EXISTS bootstrap_command text,
  -- NULL = agent-detected during analyze, recorded into the plan artifact.
  ADD COLUMN IF NOT EXISTS test_command text;

-- --- the durable human gate ------------------------------------------------
-- Modelled on conductor_awaits: one open gate per job (partial unique index),
-- principal is a user sub or a role key, resolution is a compare-and-swap.
CREATE TABLE IF NOT EXISTS dev_job_gates (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id            UUID NOT NULL REFERENCES dev_jobs(id) ON DELETE CASCADE,
  plan_artifact_id  UUID REFERENCES dev_job_artifacts(id),
  plan_sha256       TEXT,                       -- exactly what the human approved
  base_sha          TEXT,                       -- the tree the plan was formed against
  questions         JSONB NOT NULL DEFAULT '[]'::jsonb,   -- [{id, text}]
  principal_kind    TEXT NOT NULL CHECK (principal_kind IN ('user','role')),
  principal_ref     TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'waiting'
                      CHECK (status IN ('waiting','resolved','rejected','expired','cancelled')),
  answers           JSONB,
  resolved_by       TEXT,
  resolved_at       TIMESTAMPTZ,
  deadline_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- At most one waiting gate per job: a crash-and-retry of the clarify→await_human
-- transition can never open a duplicate (ON CONFLICT DO NOTHING against this).
CREATE UNIQUE INDEX IF NOT EXISTS dev_job_gates_one_open
  ON dev_job_gates (job_id) WHERE status = 'waiting';

-- The deadline worker scans waiting gates by due time.
CREATE INDEX IF NOT EXISTS dev_job_gates_due_idx
  ON dev_job_gates (deadline_at) WHERE status = 'waiting';

-- --- GitHub App registry (metadata only; secrets live in Vault) -------------
-- Vault namespace core:dev-platform, keys github-app/<app_id>/{private_key,
-- webhook_secret,client_id,client_secret}. No secret ever lands in a column.
CREATE TABLE IF NOT EXISTS dev_github_apps (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id        TEXT NOT NULL UNIQUE,           -- GitHub's numeric App id, as text
  slug          TEXT NOT NULL,
  owner_login   TEXT NOT NULL,
  html_url      TEXT NOT NULL,
  api_base_url  TEXT NOT NULL DEFAULT 'https://api.github.com',   -- GHES support
  created_by    TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS dev_github_app_installations (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app_row_id       UUID NOT NULL REFERENCES dev_github_apps(id) ON DELETE CASCADE,
  installation_id  TEXT NOT NULL,
  account_login    TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (app_row_id, installation_id)
);
