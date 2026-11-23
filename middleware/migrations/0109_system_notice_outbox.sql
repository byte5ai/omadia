-- ── System notices owed outside a turn (spec 2042 §5.10, INV-7, criterion 37) ──
-- When an agent goes out of service (disabled, deleted, its archetype plugin
-- removed), each affected home conversation gets one registered `system`
-- notice, posted through the channel's shared bot, never under the agent's
-- own bot.
--
--   system_notice_outbox  one row per notice owed. Written before anything is
--                         sent, so a restart in between still delivers it
--                         (the worker drains pending rows at boot); a sent
--                         row is never sent again. The rendered text is
--                         stored, so a restart sends the same sentence.
--                         `agent_id` has no foreign key: a purged agent's
--                         notice is still owed.
--
-- Idempotent (the CI schema job applies everything twice).

CREATE TABLE IF NOT EXISTS system_notice_outbox (
  id              BIGSERIAL PRIMARY KEY,
  code            TEXT NOT NULL,
  agent_id        UUID NOT NULL,
  channel_type    TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  process_id      TEXT,
  text            TEXT NOT NULL,
  locale          TEXT NOT NULL,
  state           TEXT NOT NULL DEFAULT 'pending',
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_until     TIMESTAMPTZ,
  last_error      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at         TIMESTAMPTZ,
  CONSTRAINT system_notice_outbox_state_check CHECK (state IN ('pending', 'sending', 'sent', 'failed'))
);
CREATE INDEX IF NOT EXISTS system_notice_outbox_due_idx
  ON system_notice_outbox (state, next_attempt_at);
CREATE INDEX IF NOT EXISTS system_notice_outbox_owed_idx
  ON system_notice_outbox (agent_id, code, channel_type, conversation_id, created_at);
