-- ── Per-agent fast lane switch (#1876, spec 2042 §5.2, §8 item 10) ─────────
-- The fast path becomes the addressed agent's fast lane: its triage, planner,
-- learned plans and cache are the agent's helpers, and the operator decides
-- per agent whether it has one. TRUE keeps today's behaviour for every agent
-- (the fast path ran for every non-facilitator agent). A facilitator never
-- takes the fast lane, whatever the column says.
--
-- Idempotent (the CI schema job applies everything twice).

ALTER TABLE agents ADD COLUMN IF NOT EXISTS fast_lane BOOLEAN NOT NULL DEFAULT TRUE;
