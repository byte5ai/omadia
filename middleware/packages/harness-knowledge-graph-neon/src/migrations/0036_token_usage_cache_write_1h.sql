-- Cache writes bill by TTL: 5-minute writes at 1.25x the input rate, 1-hour
-- writes (`cache_control.ttl: '1h'`, the orchestrator's stable prefix since
-- #1634) at 2x. The ledger priced every write at 1.25x, so a 1-hour write was
-- under-billed by 0.75x the input rate and the dashboard's cache saving was
-- overstated by the same amount.
--
-- `cache_creation_1h_tokens` is the 1-hour part of `cache_creation_tokens`
-- (Anthropic `usage.cache_creation.ephemeral_1h_input_tokens`); the 5-minute
-- part is the difference. `cost_usd` is computed with the split at write time.
--
-- HARD-INVARIANTS (extending 0028):
-- 7. cache_creation_1h_tokens <= cache_creation_tokens (the recorder clamps).
--    0 for every row written before this migration: their split is unknown, and
--    their cost_usd stays as written. Whether to correct historical rows is a
--    separate, operator-run decision, not part of this migration.
--
-- Idempotent: IF NOT EXISTS, so a re-run or a partially applied deploy is a
-- no-op.

ALTER TABLE token_usage
  ADD COLUMN IF NOT EXISTS cache_creation_1h_tokens BIGINT NOT NULL DEFAULT 0;
