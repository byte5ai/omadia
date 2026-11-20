-- Spec 2042 §5.4 / ADR-0018 (#2047) — consultation instead of delegation.
--
-- Agent A may ask agent B as a colleague. Consulting adds B's skill and
-- judgement, never access: B's data access in the run is the intersection of
-- the grant's allowed capabilities, B's grants, A's grants and the audience.
--
-- 1. Two per-agent switches, both default off:
--    `consultable` (may other agents consult it at all) and
--    `may_consult` (may it consult others at all).
-- 2. `agent_consultation_grants` — directed, operator-managed, revocable:
--    A (from) may consult B (to). No row = not allowed.
--    - `channel_scope`: channel types the grant holds in; NULL = every channel.
--    - `allowed_capabilities`: plugin ids (or `mcp:<serverId>`) of B's that B
--      may use while answering A; empty (default) = instructions, skills and
--      general knowledge only.
--    - `memory_access`: `none` (default) or `discreet` (B's memory, only what
--      the discretion rule lets flow to A and A's audience).
--    - `disclosure`: disclosure level per data classification (spec §5.11
--      "How much"); `{}` = `none` for everything B adds that A could not
--      know itself.
--    - per-turn and per-day call budgets.
-- 3. `agent_consultation_calls` — one row per consult call: the budget ledger
--    (calls per day) and the link between A's turn and B's run, so B's cost
--    (recorded under B's own turn id) is attributable to A's turn.
--
-- The existing per-agent switch `agents.agent_to_agent` and the per-chat
-- `agent_channel_policies` (0058) stay; a discussion between two agents now
-- additionally needs grants in both directions (spec §5.4, "One authorization").
--
-- Idempotent: the schema CI gate applies every file twice.

ALTER TABLE agents ADD COLUMN IF NOT EXISTS consultable BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS may_consult BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN agents.consultable IS
  'Spec 2042 §5.4 — may other agents consult this agent at all (default off). Needs a directed grant too.';
COMMENT ON COLUMN agents.may_consult IS
  'Spec 2042 §5.4 — may this agent consult other agents at all (default off). Needs a directed grant too.';

CREATE TABLE IF NOT EXISTS agent_consultation_grants (
  from_agent_id        UUID        NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  to_agent_id          UUID        NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  channel_scope        TEXT[],
  allowed_capabilities TEXT[]      NOT NULL DEFAULT '{}',
  memory_access        TEXT        NOT NULL DEFAULT 'none',
  disclosure           JSONB       NOT NULL DEFAULT '{}'::jsonb,
  max_calls_per_turn   INTEGER     NOT NULL DEFAULT 2,
  max_calls_per_day    INTEGER     NOT NULL DEFAULT 50,
  created_by           TEXT        NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by           TEXT,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (from_agent_id, to_agent_id)
);

CREATE INDEX IF NOT EXISTS agent_consultation_grants_to_idx
  ON agent_consultation_grants (to_agent_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'agent_consultation_grants_shape_check'
       AND conrelid = 'agent_consultation_grants'::regclass
  ) THEN
    ALTER TABLE agent_consultation_grants
      ADD CONSTRAINT agent_consultation_grants_shape_check
      CHECK (
        from_agent_id <> to_agent_id
        AND memory_access IN ('none', 'discreet')
        AND jsonb_typeof(disclosure) = 'object'
        AND max_calls_per_turn BETWEEN 1 AND 10
        AND max_calls_per_day BETWEEN 1 AND 10000
      );
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS agent_consultation_calls (
  id            UUID        PRIMARY KEY,
  from_agent_id UUID        NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  to_agent_id   UUID        NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  -- A's turn (the kernel's turn id) and B's run (its own turn id, under which
  -- B's model usage is recorded in `token_usage`).
  from_turn_id  TEXT        NOT NULL,
  to_turn_id    TEXT,
  channel_type  TEXT,
  status        TEXT        NOT NULL DEFAULT 'running',
  -- Outcome code only (`full`, `redacted`, `existence`, `none`, `timeout` …), never text.
  -- Refused calls are not recorded: only calls that started a run.
  outcome       TEXT,
  started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at   TIMESTAMPTZ
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'agent_consultation_calls_status_check'
       AND conrelid = 'agent_consultation_calls'::regclass
  ) THEN
    ALTER TABLE agent_consultation_calls
      ADD CONSTRAINT agent_consultation_calls_status_check
      CHECK (status IN ('running', 'delivered', 'withheld', 'failed'));
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS agent_consultation_calls_budget_idx
  ON agent_consultation_calls (from_agent_id, to_agent_id, started_at);
CREATE INDEX IF NOT EXISTS agent_consultation_calls_turn_idx
  ON agent_consultation_calls (from_turn_id);

-- rollback:
--   DROP TABLE agent_consultation_calls;
--   DROP TABLE agent_consultation_grants;
--   ALTER TABLE agents DROP COLUMN may_consult, DROP COLUMN consultable;
