-- OM-103 — make the cost ledger able to hold a SUBSCRIPTION call.
--
-- The ledger was built for metered API calls: `cost_usd` is derived from a
-- price table at write time and every aggregation sums it. A turn run through
-- the `claude-cli` subscription has no per-token price at all — the operator
-- already paid a flat fee — but the CLI does report a `total_cost_usd` for
-- what the same work WOULD have cost on the API. Writing that number into
-- `cost_usd` would inflate "Gesamtkosten" with money nobody spent; writing 0
-- and dropping the number loses the one figure that makes the subscription
-- worth explaining. So it gets its own column.
--
-- HARD-INVARIANTS (extending 0028):
-- 4. cost_usd stays BILLED money only. A subscription row is 0 there.
-- 5. reference_cost_usd is informational — never summed into a billed total,
--    never used for a budget or an alert. NOT NULL DEFAULT 0 so every
--    pre-existing row reads as "no reference cost" without a backfill.
--
-- Idempotent: IF NOT EXISTS, so a re-run against a migrated database is a
-- no-op and a partially applied deploy can simply be replayed.

ALTER TABLE token_usage
  ADD COLUMN IF NOT EXISTS reference_cost_usd NUMERIC(14,8) NOT NULL DEFAULT 0;
