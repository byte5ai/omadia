-- ── Observed conversation invites survive restarts (#330 follow-up) ────────
-- The kernel-side invite index (#330 C2a) is the scope guard for plugin
-- auto-binds: a plugin can only bind a conversation the transport actually
-- reported a group bot_added for. Until now that index was purely in-memory,
-- so every deploy/restart forced operators to remove and re-invite the bot
-- before a facilitation could start. This table is the write-through backing
-- store; the in-memory map stays the hot path and is hydrated from here at
-- boot (TTL-filtered, live events win over hydrated rows).
--
-- seen_at is epoch milliseconds (BIGINT) because the index's TTL arithmetic
-- lives in JS `Date.now()` space — round-tripping through timestamptz would
-- just invite timezone/precision drift for zero gain.

CREATE TABLE IF NOT EXISTS observed_conversation_invites (
  channel_type    TEXT   NOT NULL,
  conversation_id TEXT   NOT NULL,
  invite          JSONB  NOT NULL,
  seen_at         BIGINT NOT NULL,
  PRIMARY KEY (channel_type, conversation_id)
);
