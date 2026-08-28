-- #757 — persistent per-turn audit receipts.
--
-- The per-turn PrivacyReceipt was, until now, attached to the `done` event and
-- discarded — nothing let an operator answer "what did the system disclose or
-- mask for turn X last Tuesday?". This table persists it, one row per turn,
-- written synchronously by the orchestrator at turn end (no optional graph
-- sink, no user-cluster precondition — deliberately NOT the RunTrace, which is
-- best-effort telemetry).
--
-- The payload is PII-free by construction (counts + verb names, see
-- plugin-api/src/privacyReceipt.ts); turn_id + scope are personal-data
-- LINKAGE, so retention is bounded by RECEIPT_RETENTION_DAYS via a reaper.
--
-- 0038 is reserved for the Satellites epic (#746); this series continues at 0039.

CREATE TABLE IF NOT EXISTS turn_receipts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  turn_id       TEXT NOT NULL,
  session_scope TEXT,
  channel       TEXT,
  model         TEXT,
  receipt       JSONB NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Idempotence key: a replayed `done` event must not duplicate the row.
CREATE UNIQUE INDEX IF NOT EXISTS turn_receipts_turn_id
  ON turn_receipts (turn_id);

-- Operator list view: newest first, optionally filtered by scope.
CREATE INDEX IF NOT EXISTS turn_receipts_scope_created
  ON turn_receipts (session_scope, created_at DESC);
CREATE INDEX IF NOT EXISTS turn_receipts_created
  ON turn_receipts (created_at DESC);
