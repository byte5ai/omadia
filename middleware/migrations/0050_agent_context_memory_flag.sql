-- Epic #860 / W5 — per-Agent rollout switch for chat-context-scoped memory.
--
-- Agent memory is isolated per AGENT today: what an Agent learns in Teams team
-- A lands in one agent-global tree and is quotable in team B on the next turn.
-- W5 partitions that tree by chat context. This column is the switch that turns
-- the partitioning on, per Agent.
--
--   'off'            — DEFAULT. Byte-identical to today: every turn gets the
--                      agent-private memory stack, whether or not its channel
--                      plugin sends a TurnOrigin.
--   'enforce'        — a context turn writes into its own tier and reads the
--                      agent tier READ-ONLY, so existing knowledge stays
--                      quotable but "note this globally" stops being a leak
--                      channel from team A into team B.
--   'enforce-strict' — full quarantine: a context turn cannot even read the
--                      agent tier.
--
-- Default 'off' is the no-flag-day guarantee: every existing row reports 'off'
-- the moment this lands, so no deployment changes behaviour until an operator
-- flips an Agent deliberately. NOT NULL + DEFAULT rather than a nullable
-- column, so a NULL can never be read as "some other mode".
--
-- The CHECK constraint is created separately and guarded, because
-- `ADD CONSTRAINT` has no IF NOT EXISTS in PostgreSQL and this migration must
-- be applicable twice (schema CI gate).
ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS context_memory TEXT NOT NULL DEFAULT 'off';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'agents_context_memory_check'
  ) THEN
    ALTER TABLE agents
      ADD CONSTRAINT agents_context_memory_check
      CHECK (context_memory IN ('off', 'enforce', 'enforce-strict'));
  END IF;
END
$$;

COMMENT ON COLUMN agents.context_memory IS
  'W5 memory-ACL rollout switch: off | enforce | enforce-strict. Default off = today''s agent-global memory.';
