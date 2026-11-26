-- #1776 — what a run cost (USD, the turn's metered model cost, ADR 0088), so
-- the run history and the routine show it. NULL = not metered (rows from
-- before this migration, runs that never reached a model).

ALTER TABLE routine_runs
  ADD COLUMN IF NOT EXISTS cost_usd NUMERIC(12, 6) NULL;
