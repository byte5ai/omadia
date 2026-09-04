-- #1033 W0 — attribute a turn receipt to the model that actually answered.
--
-- `turn_receipts.model` (0039) was written from the orchestrator's CONFIGURED
-- model (`this.model`), not from the model the turn resolved to (`turnModel`,
-- which triage routing already varies per turn and which a provider fallback
-- will vary further). A receipt that names a model the turn never ran on is
-- worse than no model at all: it answers "what answered this?" wrongly with
-- full confidence.
--
-- Two additive columns:
--   * `provider`      — the provider id the turn ran on (`anthropic`, `openai`,
--                       a plugin provider id). NULL on rows written before
--                       this migration; never backfilled, because the value
--                       was not recorded and inventing it would be the same
--                       defect in a new coat.
--   * `fallback_used` — TRUE when the turn ran on the agent's fallback
--                       provider/model instead of its primary. Always FALSE
--                       until the fallback path (W3) lands; recorded from the
--                       start so the column carries the same meaning across
--                       every row that has it.
--
-- Deliberately NOT part of the hash-chain payload (`receiptChainPayload`):
-- the chain (#758) seals the privacy receipt, and widening the sealed shape
-- would either bump HASH_VERSION — marking every existing row
-- `unsupported_hash_version` — or fork the verifier by version. Attribution
-- is operational metadata read from operator surfaces, not audit content.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, so the schema CI's double-apply is a
-- no-op the second time.
ALTER TABLE turn_receipts
  ADD COLUMN IF NOT EXISTS provider TEXT;

ALTER TABLE turn_receipts
  ADD COLUMN IF NOT EXISTS fallback_used BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN turn_receipts.provider IS
  'Provider id the turn actually ran on. NULL = recorded before #1033 W0.';
COMMENT ON COLUMN turn_receipts.fallback_used IS
  'TRUE when the turn ran on the agent''s fallback model instead of its primary.';

-- rollback: ALTER TABLE turn_receipts DROP COLUMN provider, DROP COLUMN fallback_used;
