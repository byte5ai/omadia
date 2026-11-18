-- Cost telemetry (OB-cost-dashboard): append-only LLM token-usage ledger.
--
-- One row per LLM call from the seams that record into it via
-- @omadia/usage-telemetry: the orchestrator (streamed and buffered), sub-agents,
-- the builder, plugin ctx.llm, the extras/verifier background calls and the
-- subscription CLI. A call through a path without a capture seam is not here
-- (#1390: the buffered orchestrator path and ctx.llm were missing). The cost
-- dashboard aggregates over it (per model, per source, over time, cache-hit
-- ratio). Cost is computed at write time from a model price table and frozen
-- into cost_usd, so later price-table edits never rewrite history.
--
-- HARD-INVARIANTS:
-- 1. Append-only — no UPDATE/DELETE on the hot path. Retention via a future
--    cleanup cron (cost rows are cheap; keep a long window).
-- 2. cost_usd is authoritative-at-write — derived, frozen, never recomputed.
-- 3. tenant_id / session_id are nullable: not every capture seam knows them
--    yet (streaming.ts has model+source+usage but not always the session).
--    Columns exist now so attribution can be backfilled without a migration.

CREATE TABLE IF NOT EXISTS token_usage (
  id                     BIGSERIAL    PRIMARY KEY,
  source                 TEXT         NOT NULL,
  model                  TEXT         NOT NULL,
  input_tokens           BIGINT       NOT NULL DEFAULT 0,
  output_tokens          BIGINT       NOT NULL DEFAULT 0,
  cache_read_tokens      BIGINT       NOT NULL DEFAULT 0,
  cache_creation_tokens  BIGINT       NOT NULL DEFAULT 0,
  cost_usd               NUMERIC(14,8) NOT NULL DEFAULT 0,
  tenant_id              TEXT         NULL,
  session_id             TEXT         NULL,
  created_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Dashboard hot path: time-windowed scans + time-series bucketing.
CREATE INDEX IF NOT EXISTS idx_token_usage_created_at
  ON token_usage (created_at DESC);

-- Per-model / per-source breakdowns within a window.
CREATE INDEX IF NOT EXISTS idx_token_usage_model_created
  ON token_usage (model, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_token_usage_source_created
  ON token_usage (source, created_at DESC);
