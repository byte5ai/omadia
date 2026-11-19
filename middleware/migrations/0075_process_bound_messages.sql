-- ── Process-bound message subscriptions (#2089, spec 2043 §0 and §5.3) ─────
-- A subscription of 'conversationMessages@2' belongs to one PROCESS (a
-- facilitation) and has a MODE:
--
--   all        every human message of the conversation (the mention gate is
--              lifted for the agent's bot)
--   addressed  only messages addressed to the agent: a mention, a reply to
--              one of the process's messages, an answer to one of its cards
--   none       nothing is delivered; what was stored stays readable
--
-- `process_id IS NULL` is a subscription of the first major: no process,
-- always `all`, at most one active per conversation and identity, as before.
--
-- One identity may hold several process subscriptions in one conversation (a
-- new facilitation next to older ones in their follow-up). A process
-- subscribes a conversation ONCE: its row carries every event the process
-- ever received there, so every read is bound to the process, and a later
-- process (its own row) sees none of an earlier one's events.
--
-- conversation_process_messages: which process a message or card of the
-- agent belongs to. A reply to it, or an answer to that card, is delivered to
-- that process alone.
--
-- Idempotent (the CI schema job applies everything twice).

ALTER TABLE conversation_message_subscriptions ADD COLUMN IF NOT EXISTS process_id TEXT;
ALTER TABLE conversation_message_subscriptions ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'all';

ALTER TABLE conversation_message_subscriptions DROP CONSTRAINT IF EXISTS conversation_message_subscriptions_mode_check;
ALTER TABLE conversation_message_subscriptions ADD CONSTRAINT conversation_message_subscriptions_mode_check
  CHECK (mode IN ('all', 'addressed', 'none') AND (process_id IS NOT NULL OR mode = 'all'));

-- First major: one active subscription per conversation and identity.
DROP INDEX IF EXISTS conversation_message_subscriptions_active_uq;
CREATE UNIQUE INDEX IF NOT EXISTS conversation_message_subscriptions_active_v1_uq
  ON conversation_message_subscriptions (channel_type, conversation_id, channel_key)
  WHERE ended_at IS NULL AND process_id IS NULL;
-- Second major: one row per process, conversation and identity, for good.
CREATE UNIQUE INDEX IF NOT EXISTS conversation_message_subscriptions_process_uq
  ON conversation_message_subscriptions (channel_type, conversation_id, channel_key, plugin_id, process_id)
  WHERE process_id IS NOT NULL;

ALTER TABLE conversation_message_events ADD COLUMN IF NOT EXISTS addressed_to_bot BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS conversation_process_messages (
  channel_type    TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  -- A message id, or 'card:<card id>'.
  ref             TEXT NOT NULL,
  agent_id        UUID NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  plugin_id       TEXT NOT NULL,
  process_id      TEXT NOT NULL,
  bound_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (channel_type, conversation_id, ref)
);
CREATE INDEX IF NOT EXISTS conversation_process_messages_process_idx
  ON conversation_process_messages (plugin_id, process_id);
