-- ── Authenticated inbound conversation messages (#2043, `conversationMessages@1`) ──
-- A facilitator has to see EVERY human message of the group it moderates, not
-- only the ones that mention it, and the facilitation engine (a plugin) has to
-- know who wrote each one without being able to make that up. So the KERNEL
-- stores what the channel adapter reports; the engine reads the record by id
-- and copies authorship from it.
--
-- Two tables, and deliberately nothing about facilitations: lifecycle, state
-- and counting live in the engine plugin's own tables.
--
-- conversation_message_subscriptions
--   "Agent A, as its own channel identity K, receives every message of
--   conversation C." At most ONE active row per (channel type, conversation,
--   identity). Ending a subscription keeps the row (`ended_at`) for the grace
--   period so a purge job can find its events; subscribing again creates a NEW
--   row, which is what makes a message from before the new subscription
--   invisible to it.
--
-- conversation_message_events
--   One row per stored platform event, append-only. `event_seq` is the
--   kernel-assigned id and the replay cursor. `revision` is assigned by the
--   KERNEL (0 for the original, max + 1 for every later edit or deletion): the
--   Teams adapter counts edits in memory and starts again at 1 after a restart,
--   so its number is a hint, kept in `adapter_revision`. `dedupe_key` makes a
--   redelivered platform event a no-op instead of a second record.
--
-- Retention: events are removed a short grace period after the subscription
-- ends, and after a maximum age regardless (kernel job, see
-- CONVERSATION_MESSAGES_* in .env.example). The engine keeps what it needs for
-- its own record.

CREATE TABLE IF NOT EXISTS conversation_message_subscriptions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id        UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  agent_slug      TEXT NOT NULL,
  channel_type    TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  -- The receiving identity, lower-cased (Teams: `28:<appid>`). Adapters ask
  -- with a lower-cased key on the hot path; the kernel normalises on write.
  channel_key     TEXT NOT NULL CHECK (channel_key = lower(channel_key)),
  -- The engine plugin that subscribed; only it reads the events.
  plugin_id       TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at        TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS conversation_message_subscriptions_active_uq
  ON conversation_message_subscriptions (channel_type, conversation_id, channel_key)
  WHERE ended_at IS NULL;

CREATE INDEX IF NOT EXISTS conversation_message_subscriptions_agent_idx
  ON conversation_message_subscriptions (agent_slug, channel_type, conversation_id);

CREATE INDEX IF NOT EXISTS conversation_message_subscriptions_ended_idx
  ON conversation_message_subscriptions (ended_at)
  WHERE ended_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS conversation_message_events (
  event_seq           BIGSERIAL PRIMARY KEY,
  subscription_id     UUID NOT NULL
                        REFERENCES conversation_message_subscriptions(id) ON DELETE CASCADE,
  message_id          TEXT NOT NULL,
  revision            INTEGER NOT NULL CHECK (revision >= 0),
  adapter_revision    INTEGER,
  kind                TEXT NOT NULL
                        CHECK (kind IN ('created', 'edited', 'deleted', 'reaction', 'card_answer')),
  dedupe_key          TEXT NOT NULL,
  author_kind         TEXT NOT NULL,
  author_id           TEXT NOT NULL,
  author_display_name TEXT,
  author_principal_id TEXT,
  tenant_id           TEXT,
  body                TEXT,
  reply_to_message_id TEXT,
  quoted              BOOLEAN NOT NULL DEFAULT false,
  forwarded           BOOLEAN NOT NULL DEFAULT false,
  reaction            JSONB,
  card_answer         JSONB,
  occurred_at         TIMESTAMPTZ NOT NULL,
  received_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A redelivered platform event is the same record, not a new one.
CREATE UNIQUE INDEX IF NOT EXISTS conversation_message_events_dedupe_uq
  ON conversation_message_events (subscription_id, dedupe_key);

-- One record per revision of a message. Reactions and card answers refer to a
-- message; they are not revisions of it.
CREATE UNIQUE INDEX IF NOT EXISTS conversation_message_events_revision_uq
  ON conversation_message_events (subscription_id, message_id, revision)
  WHERE kind IN ('created', 'edited', 'deleted');

CREATE INDEX IF NOT EXISTS conversation_message_events_replay_idx
  ON conversation_message_events (subscription_id, event_seq);

CREATE INDEX IF NOT EXISTS conversation_message_events_received_idx
  ON conversation_message_events (received_at);

-- rollback:
--   DROP TABLE IF EXISTS conversation_message_events;
--   DROP TABLE IF EXISTS conversation_message_subscriptions;
