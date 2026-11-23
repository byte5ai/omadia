-- Spec 2042 §5.11 "Defaults" / ADR-0019 (#2079) — the context-memory ACL is on
-- for every agent in mode `members`: recall uses only knowledge everyone
-- present owns (0062). Until now the column defaulted to `off` (0050).
--
-- Every agent created from now on starts in `members` (`INSERT INTO agents`
-- does not name the column, so the DEFAULT decides).
--
-- Existing agents are NOT switched here. `members` reads notes from per-room
-- owner tiers, so switching an agent that ran `off` would hide every note it
-- wrote before, on a live instance, without anyone deciding it. Operators
-- switch those agents themselves; the operator API refuses `off` for an agent
-- that holds any capability grant (spec: "never `off` for an agent with access
-- to classified data").
--
-- Idempotent.

ALTER TABLE agents ALTER COLUMN context_memory SET DEFAULT 'members';

COMMENT ON COLUMN agents.context_memory IS
  'W5 memory-ACL / spec 2042 §5.11: off | enforce | enforce-strict | members (default since 0099). off is refused for agents with capability grants.';
