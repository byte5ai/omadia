-- 0062 — member-scoped memory: `agents.context_memory` accepts 'members'.
--
--   'members' — a context turn's graph recall and `query_knowledge_graph` use
--               the knowledge everyone present owns (the people present when
--               it was created), from any conversation and channel of the
--               agent; the memory tree is quarantined like 'enforce-strict'.
--
-- 0050 created `agents_context_memory_check` and 0056 repairs it when it is
-- missing; both test only for the constraint's NAME, so neither would ever
-- widen it. This migration replaces it. Drop-then-add keeps it applicable
-- twice (schema CI gate), and the new list is a superset of the old one, so
-- no existing row can fail it.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'agents' AND relkind = 'r') THEN
    ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_context_memory_check;
    ALTER TABLE agents
      ADD CONSTRAINT agents_context_memory_check
      CHECK (context_memory IN ('off', 'enforce', 'enforce-strict', 'members'));
  END IF;
END
$$;

COMMENT ON COLUMN agents.context_memory IS
  'W5 memory-ACL rollout switch: off | enforce | enforce-strict | members. Default off = today''s agent-global memory.';
