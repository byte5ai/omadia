-- Epic #470 W0 — dev platform job spine.
-- Queue state lives in Postgres from day one (deliberately NOT the builder's
-- in-memory BuildQueue): a restart must never orphan jobs. Claim/lease columns
-- mirror conductor_runs (src/conductor/migrations/0004_conductor_run_claim.sql).
-- No CHECK constraints on `dev_job_events.type`/`dev_job_artifacts.kind`: both
-- enums grow in W1-W3 and are validated in TypeScript (src/devplatform/types.ts).
-- A CHECK on a growing enum is a liability. Forward-only, idempotent.

CREATE TABLE IF NOT EXISTS dev_repos (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  forge_kind            TEXT NOT NULL DEFAULT 'github',
  owner                 TEXT NOT NULL,
  name                  TEXT NOT NULL,
  clone_url             TEXT NOT NULL,                              -- https only in W0
  default_branch        TEXT NOT NULL DEFAULT 'main',
  credential_kind       TEXT NOT NULL
                          CHECK (credential_kind IN ('github_app','device_flow','pat','deploy_key')),
  credential_ref        TEXT NOT NULL,                              -- Vault key prefix, e.g. 'repo/<id>'
  tracker_kind          TEXT,
  tracker_config        JSONB NOT NULL DEFAULT '{}'::jsonb,
  allowed_triggers      TEXT[] NOT NULL DEFAULT ARRAY['admin'],
  allowed_launchers     TEXT[] NOT NULL DEFAULT '{}',               -- empty = created_by only (see spec §6)
  egress_allowlist      TEXT[] NOT NULL DEFAULT '{}',               -- W1 proxy reads this; never caller-supplied
  runs_tests            BOOLEAN NOT NULL DEFAULT true,              -- false is the only local-backend-eligible repo
  branch_protection_ok  BOOLEAN,
  branch_protection_checked_at TIMESTAMPTZ,
  created_by            TEXT NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (forge_kind, owner, name)
);

CREATE TABLE IF NOT EXISTS dev_jobs (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_id            UUID NOT NULL REFERENCES dev_repos(id) ON DELETE CASCADE,
  kind               TEXT NOT NULL CHECK (kind IN ('analyze','fix_issue','implement')),
  brief              TEXT NOT NULL,
  source             TEXT NOT NULL CHECK (source IN ('chat','admin','conductor','webhook','schedule','tracker')),
  source_ref         TEXT,                                          -- e.g. 'gh-issue:123'
  base_sha           TEXT,                                          -- pinned at job start; W2 re-clones this exact tree
  backend            TEXT NOT NULL CHECK (backend IN ('local','docker','fly')),
  agent_kind         TEXT NOT NULL DEFAULT 'claude-cli',
  auth_mode          TEXT NOT NULL DEFAULT 'api_key'
                       CHECK (auth_mode IN ('api_key','subscription')),   -- see spec §6b (Q4 decision)
  provision          INTEGER NOT NULL DEFAULT 1,                    -- bumped per runner session (W2 gated pipeline)
  phase              TEXT NOT NULL DEFAULT 'implement',             -- unconstrained: W2 grows the phase set
  status             TEXT NOT NULL DEFAULT 'queued'
                       CHECK (status IN ('queued','provisioning','running','waiting','applying',
                                         'done','failed','cancelled','stalled','budget_exceeded')),
  claimed_by         UUID,                                          -- lease token; MUST be a UUID (randomUUID())
  claimed_at         TIMESTAMPTZ,
  last_heartbeat_at  TIMESTAMPTZ,
  runner_handle      JSONB,
  runner_token_hash  TEXT,                                          -- sha256 hex; plaintext never stored
  branch             TEXT,
  pr_url             TEXT,
  result             JSONB,
  error              TEXT,
  tokens_in          BIGINT NOT NULL DEFAULT 0,
  tokens_out         BIGINT NOT NULL DEFAULT 0,
  cost_usd           NUMERIC(12,4) NOT NULL DEFAULT 0,
  created_by         TEXT NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at         TIMESTAMPTZ,
  ended_at           TIMESTAMPTZ,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS dev_jobs_queued_idx
  ON dev_jobs(created_at) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS dev_jobs_active_idx
  ON dev_jobs(last_heartbeat_at, started_at)
  WHERE status IN ('provisioning','running','applying');
CREATE INDEX IF NOT EXISTS dev_jobs_repo_idx ON dev_jobs(repo_id, created_at DESC);

CREATE TABLE IF NOT EXISTS dev_job_events (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,   -- the ONLY ordering key; SSE id: and Last-Event-ID
  job_id     UUID NOT NULL REFERENCES dev_jobs(id) ON DELETE CASCADE,
  provision  INTEGER NOT NULL DEFAULT 1,                        -- which runner session emitted this
  seq        INTEGER NOT NULL,                                  -- runner-assigned, monotonic WITHIN a provision
  type       TEXT NOT NULL,                                     -- log|tool|status|heartbeat|egress|token|gate|phase|approval (validated in TS)
  ts         TIMESTAMPTZ NOT NULL DEFAULT now(),
  payload    JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (job_id, provision, seq)                               -- idempotent batch retry, no cross-provision collision
);
CREATE INDEX IF NOT EXISTS dev_job_events_job_idx ON dev_job_events(job_id, id);

CREATE TABLE IF NOT EXISTS dev_job_artifacts (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id     UUID NOT NULL REFERENCES dev_jobs(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,                                     -- diff|test_report|analysis|plan|summary|… (W2/W3 add more; validated in TS)
  content    TEXT NOT NULL,
  meta       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS dev_job_artifacts_job_idx ON dev_job_artifacts(job_id);
