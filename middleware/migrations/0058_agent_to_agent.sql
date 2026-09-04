-- #1018 W0 — the two operator switches for agent-to-agent conversation.
--
-- Agent-to-agent talk already ships as a Conductor relay (`discussion`
-- pattern, #1021/#1026/#1032): every participant posts under its own bot, the
-- kernel rotates the floor and bounds the length. What #1018 asks for and
-- this migration adds is CONTROL over it — per agent AND per chat, never a
-- global flag — so the same agent can converse with peers in one channel and
-- stay silent toward them in another.
--
-- 1. `agents.agent_to_agent` — the agent's own switch. Same shape as the
--    `context_memory` precedent (0050): TEXT + guarded CHECK rather than a
--    BOOLEAN, so a third mode can be added without a type change, and
--    NOT NULL + DEFAULT so a NULL can never be read as "some other mode".
--
--    Default `'off'` — with one deliberate exception. The relay is LIVE
--    today, gated only by the grant on the discussion plugin. A plain
--    `'off'` default would silently switch off every existing discussion
--    the moment this migration lands, which is exactly the "it did nothing"
--    class of regression a no-flag-day migration must not cause. So agents
--    that hold the discussion plugin grant at migration time are backfilled
--    to `'on'`: what they could do yesterday they can still do today, and
--    the operator now has a switch to take it away.
--
--    The backfill runs ONLY when the column is created — a re-apply (schema
--    CI double-applies every file) must not flip an agent an operator has
--    since switched off.
--
-- 2. `agent_channel_policies` — the per-(channel, agent) side of the pair.
--    `channel_bindings` (0001) is the wrong home: its PRIMARY KEY is
--    (channel_type, channel_key), one agent per channel — the classic
--    single-agent path — and cannot express "agent X may talk to peers in
--    chat Y" for the multi-agent case. `agent_teams_installs` (0051) is
--    keyed by TEAM, and the group chats the relay runs in
--    (`19:…@thread.skype`) are not teams. Hence a generic junction keyed by
--    the pair. No row = not enabled (deny-default). The effective rule the
--    relay applies is AND: the agent's own switch must be `'on'` AND the
--    pair must be enabled for that chat.
--
-- The CHECK-constraint probe is scoped by `conrelid` (lesson of #952 /
-- 0056): a constraint NAME is unique per table, not per database, and an
-- unscoped probe skips creation whenever any other schema carries the name.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = 'agents'
       AND column_name = 'agent_to_agent'
  ) THEN
    ALTER TABLE agents
      ADD COLUMN agent_to_agent TEXT NOT NULL DEFAULT 'off';

    -- Grandfather the live relay: see header. `enabled` is the grant's own
    -- switch; a disabled grant was already not a working discussion.
    UPDATE agents a
       SET agent_to_agent = 'on'
      FROM agent_plugins ap
     WHERE ap.agent_id = a.id
       AND ap.plugin_id = '@omadia/plugin-discussion'
       AND ap.enabled = true;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'agents_agent_to_agent_check'
       AND conrelid = 'agents'::regclass
  ) THEN
    ALTER TABLE agents
      ADD CONSTRAINT agents_agent_to_agent_check
      CHECK (agent_to_agent IN ('off', 'on'));
  END IF;
END
$$;

COMMENT ON COLUMN agents.agent_to_agent IS
  '#1018 per-agent switch for agent-to-agent conversation: off | on. Effective only together with an enabled agent_channel_policies row for the chat.';

CREATE TABLE IF NOT EXISTS agent_channel_policies (
  channel_type   TEXT        NOT NULL,
  channel_key    TEXT        NOT NULL,
  agent_id       UUID        NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  -- The pair's side of the AND rule. A row exists so an operator can also
  -- record an explicit `false` (visible in the UI as "switched off here"),
  -- which a missing row cannot distinguish from "never configured".
  agent_to_agent BOOLEAN     NOT NULL DEFAULT false,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (channel_type, channel_key, agent_id)
);

CREATE INDEX IF NOT EXISTS agent_channel_policies_agent_idx
  ON agent_channel_policies (agent_id);

-- rollback:
--   DROP TABLE agent_channel_policies;
--   ALTER TABLE agents DROP CONSTRAINT agents_agent_to_agent_check;
--   ALTER TABLE agents DROP COLUMN agent_to_agent;
