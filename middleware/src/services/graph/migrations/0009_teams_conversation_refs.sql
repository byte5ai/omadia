-- ── Teams conversation references survive restarts (#330 field report) ─────
-- The Teams channel plugin keeps a per-conversation Bot-Framework
-- ConversationReference cache to open proactive turns (roster reads, group
-- nudges via conversationSend). That cache was in-memory only: after every
-- middleware restart (Fly machines restart routinely) proactive delivery
-- answered `no_binding` until the conversation happened to produce a new
-- inbound activity — an overnight facilitation could never nudge its group.
-- This table is the write-through backing store; the in-memory LRU stays the
-- hot path and rows are loaded lazily on cache miss.
--
-- Owned by the channel-teams plugin (same pattern as `teams_attachments`,
-- 0008): the kernel ships the schema, the plugin reads/writes via graphPool.

CREATE TABLE IF NOT EXISTS teams_conversation_refs (
  conversation_id TEXT PRIMARY KEY,
  ref             JSONB NOT NULL,
  teams_type      TEXT,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
