-- ── Agent Builder schedules fire through bounded triggers (#2082) ───────────
-- Spec 2042 §5.12 / ADR-0020: nothing an agent does unasked runs without a
-- deadline. An `agent_schedules` row (Agent Builder cron, P6) now fires
-- through its one trigger (`agent_triggers`, context_kind 'schedule'), which
-- carries the budget, the kill switch and the circuit breaker. `until` is the
-- schedule's deadline: set when the schedule is armed, moved by a renewal,
-- and when it passes the schedule is disabled until an operator renews it.
--
-- Idempotent (the CI schema job applies everything twice).

ALTER TABLE agent_schedules ADD COLUMN IF NOT EXISTS until TIMESTAMPTZ;
