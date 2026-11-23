-- ── An agent's own bot on any channel (spec 2042 §5.3, §8 item 20) ─────────
-- One row per agent and channel type for which the agent has a bot of its
-- own: a Telegram bot from BotFather, a Discord application, a Slack app.
-- The channel plugin that runs the bot registers it (`agentIdentities@1` in
-- the channel SDK) and returns the bot's routing key; the kernel stores the
-- key here, and routing reads it exactly like a provisioned Teams bot
-- (`ConfigStore.listChannelIdentities`): a turn that arrives through the bot
-- belongs to its agent and to nobody else, and the agent speaks through it.
--
-- WHY TEAMS IS NOT IN HERE
-- ------------------------
-- A Teams identity is the end of a provisioning chain (Entra app, Azure bot,
-- app package, catalog, install) that `agent_teams_identities` (0049) tracks
-- step by step. Its routing key `28:<appId>` is derived from that row. A copy
-- here would be a second source of truth that drifts, so the CHECK keeps the
-- two apart and routing reads the union.
--
-- NO SECRET COLUMN — DELIBERATE
-- -----------------------------
-- The bot's token stays in the channel plugin's vault. It crosses the kernel
-- once, from the operator's request to the plugin, and is never stored or
-- logged here. `external_ref` is what the platform shows publicly about the
-- bot (Telegram `@username`, Discord application name) and nothing more.
--
-- UNIQUE (channel_type, channel_key): one bot belongs to one agent, or two
-- agents would answer the same bot. UNIQUE (agent_id, channel_type): one bot
-- per agent and channel, so "which bot is this agent" has one answer.
--
-- The row outlives a soft delete of its agent on purpose: the bot of a
-- deleted agent is refused instead of answered by someone else (#2088). Only
-- the final purge of the agent row removes it (ON DELETE CASCADE).
--
-- Idempotent (the CI schema job applies everything twice).

CREATE TABLE IF NOT EXISTS agent_channel_identities (
  agent_id      UUID        NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  channel_type  TEXT        NOT NULL
    CONSTRAINT agent_channel_identities_type_check
      CHECK (channel_type ~ '^[a-z][a-z0-9_-]{0,31}$' AND channel_type <> 'teams'),
  channel_key   TEXT        NOT NULL
    CONSTRAINT agent_channel_identities_key_check
      CHECK (channel_key = lower(channel_key) AND length(channel_key) BETWEEN 1 AND 200),
  display_name  TEXT,
  external_ref  TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, channel_type),
  CONSTRAINT agent_channel_identities_key_unique UNIQUE (channel_type, channel_key)
);

COMMENT ON TABLE agent_channel_identities IS
  'spec 2042 §5.3: an agent''s own bot on a channel other than Teams. The token stays in the channel plugin''s vault.';

DROP TRIGGER IF EXISTS agent_channel_identities_notify ON agent_channel_identities;
CREATE TRIGGER agent_channel_identities_notify
  AFTER INSERT OR UPDATE OR DELETE ON agent_channel_identities
  FOR EACH ROW EXECUTE FUNCTION notify_agents_changed();

-- rollback: DROP TABLE agent_channel_identities;
