-- Persistence for the answer-verifier pipeline (see
-- docs/plans/answer-verifier-agent.md §10).
--
-- Two tables:
--   verifier_verdicts       — one row per pipeline run, summary metrics.
--   verifier_contradictions — one row per contradicted claim, for prompt
--                             regression analysis / fine-tuning signal.
--
-- run_id is the orchestrator's turn id (UUID, but stored as TEXT so we stay
-- aligned with existing graph_nodes.id formatting: "turn:<scope>:<time>").

CREATE TABLE IF NOT EXISTS verifier_verdicts (
  id                BIGSERIAL PRIMARY KEY,
  tenant            TEXT NOT NULL,
  run_id            TEXT NOT NULL,
  agent             TEXT NULL,
  status            TEXT NOT NULL,                  -- approved | approved_with_disclaimer | blocked
  claim_count       INTEGER NOT NULL DEFAULT 0,
  hard_count        INTEGER NOT NULL DEFAULT 0,
  soft_count        INTEGER NOT NULL DEFAULT 0,
  contradiction_count INTEGER NOT NULL DEFAULT 0,
  unverified_count  INTEGER NOT NULL DEFAULT 0,
  retry_count       INTEGER NOT NULL DEFAULT 0,
  latency_ms        INTEGER NOT NULL DEFAULT 0,
  mode              TEXT NOT NULL,                  -- shadow | enforce
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_verifier_verdicts_run
  ON verifier_verdicts (tenant, run_id);
CREATE INDEX IF NOT EXISTS idx_verifier_verdicts_created
  ON verifier_verdicts (tenant, created_at DESC);

CREATE TABLE IF NOT EXISTS verifier_contradictions (
  id              BIGSERIAL PRIMARY KEY,
  tenant          TEXT NOT NULL,
  run_id          TEXT NOT NULL,
  claim_id        TEXT NOT NULL,                   -- local claim id from the extractor ("c_001")
  claim_text      TEXT NOT NULL,
  claim_type      TEXT NOT NULL,                   -- amount | id | date | name | aggregate | qualitative
  claimed_value   TEXT NULL,
  truth_value     TEXT NULL,
  source          TEXT NOT NULL,                   -- odoo | graph | confluence | unknown
  agent           TEXT NULL,
  detail          TEXT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_verifier_contradictions_run
  ON verifier_contradictions (tenant, run_id);
CREATE INDEX IF NOT EXISTS idx_verifier_contradictions_agent
  ON verifier_contradictions (tenant, agent, created_at DESC);
