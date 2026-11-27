-- #2290 / ADR-0261 — agents on context-memory mode `off` move to `members`.
--
-- Since wave 5 (ADRs 0180–0183) web chats, API keys and memories belong to an
-- account, but an `off` agent still shares ONE memory stack across every
-- account and key (ADR-0116). Owner decision 2026-11-27: switch existing `off`
-- agents to `members`; `off` stays available only as an explicit "shared
-- agent" choice (the operator API asks for `shared: true`).
--
-- Only `standard` agents are switched. An archetype that omits memory (the
-- facilitator) is kept on `off` by the operator API, and SQL cannot ask the
-- runtime archetype registry, so every non-standard archetype is left alone.
--
-- Notes the agent wrote under `off` live in the agent tier, which `members`
-- turns do not read. `context_memory_switched_at` records the switch so the
-- memory tab can say so until an operator sets a mode again; switching back to
-- `off` (shared) makes those notes readable again. Nothing is deleted.
--
-- The runner applies this file once. Re-running it by hand only touches rows
-- still on `off` without a recorded switch, so it would also move agents an
-- operator set to `off` (shared) afterwards; do not re-run it.

ALTER TABLE agents ADD COLUMN IF NOT EXISTS context_memory_switched_at TIMESTAMPTZ;

UPDATE agents
   SET context_memory = 'members',
       context_memory_switched_at = now()
 WHERE context_memory = 'off'
   AND archetype = 'standard'
   AND context_memory_switched_at IS NULL;

COMMENT ON COLUMN agents.context_memory_switched_at IS
  '#2290 / ADR-0261: set when migration 0122 moved the agent from off to members; cleared by the next operator mode change.';
