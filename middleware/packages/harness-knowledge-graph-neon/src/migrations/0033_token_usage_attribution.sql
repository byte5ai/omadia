-- #1098 — make a cost-ledger row attributable to the turn that produced it.
--
-- 0028 shipped `tenant_id`/`session_id` NULL "so attribution can be backfilled
-- without a migration", but no write site ever passed them and there was no
-- `turn_id` at all, so a turn — the unit a user actually asks "what did this
-- cost?" about — could not be identified even in principle. A single turn emits
-- several rows (one per streaming iteration plus background extras / model- and
-- persona-router calls); without a shared key they are indistinguishable, and a
-- time-window heuristic fails too because the recorder flushes on a 5s grid.
--
-- This adds the missing grouping key and, mirroring `turn_receipts.provider`
-- (middleware migration 0057), the provider that actually generated the cost so
-- a fallback is visible in the ledger. `created_at` is unchanged in shape — the
-- recorder now writes it explicitly at call time instead of leaning on the
-- flush-time DEFAULT NOW(), so no column change is needed for the timestamp.
--
-- HARD-INVARIANTS (extending 0028):
-- 6. turn_id / provider are nullable: background call sites with no turn
--    context (and every pre-existing row) read as NULL rather than failing.
--    session_id remains best-effort — it is NOT a stand-alone key (unscoped
--    HTTP turns share the literal 'http-default'; see #445), so group on
--    turn_id.
--
-- Idempotent: IF NOT EXISTS throughout, so a re-run or a partially applied
-- deploy is a no-op.

ALTER TABLE token_usage
  ADD COLUMN IF NOT EXISTS turn_id  TEXT NULL,
  ADD COLUMN IF NOT EXISTS provider TEXT NULL;

-- Per-turn / per-session aggregation ("what did this turn cost?"). Partial:
-- the vast majority of historical rows are NULL and never grouped on.
CREATE INDEX IF NOT EXISTS idx_token_usage_turn_id
  ON token_usage (turn_id)
  WHERE turn_id IS NOT NULL;
