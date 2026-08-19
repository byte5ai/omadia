-- #584 — append-only transcription-minute usage ledger.
--
-- Every transcription provider call (batch today, realtime in the follow-up
-- PR) writes one row here via @omadia/usage-telemetry's transcription
-- recorder. Two quantities per row: source_minutes (probed duration of the
-- source recording, counted exactly once per recording) and billed_minutes
-- (client-derived ESTIMATE of provider-billed time — the provider reports no
-- per-call billing figure; every retry books in full). The per-agent monthly
-- quota sums billed_minutes over date_trunc('month', created_at).
--
-- HARD-INVARIANTS:
-- 1. Append-only — no UPDATE/DELETE on the hot path.
-- 2. cost_usd is authoritative-at-write — derived from the per-minute price
--    table, frozen, never recomputed. Price-table edits never rewrite history.
-- 3. turn_id is nullable: a call outside a turn context (future ingestion
--    paths) still books. agent_id is NOT NULL — the quota needs the agent
--    dimension on every row (the reason token_usage was not extended).

CREATE TABLE IF NOT EXISTS transcription_usage (
  id              BIGSERIAL     PRIMARY KEY,
  source_minutes  NUMERIC(12,4) NOT NULL DEFAULT 0,
  billed_minutes  NUMERIC(12,4) NOT NULL DEFAULT 0,
  model           TEXT          NOT NULL,
  cost_usd        NUMERIC(14,8) NOT NULL DEFAULT 0,
  agent_id        TEXT          NOT NULL,
  recording_id    TEXT          NOT NULL,
  turn_id         TEXT          NULL,
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- Quota hot path: per-agent calendar-month sum of billed_minutes.
CREATE INDEX IF NOT EXISTS idx_transcription_usage_agent_created
  ON transcription_usage (agent_id, created_at DESC);

-- Time-windowed scans (future usage dashboard, retention cron).
CREATE INDEX IF NOT EXISTS idx_transcription_usage_created_at
  ON transcription_usage (created_at DESC);
