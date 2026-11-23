-- ── Linked session conversations (#2076, #2089, spec 2043 §5.3) ─────────────
-- A live session of a facilitation may run in another conversation than the
-- home one (the chat of a scheduled meeting). Two kernel facts belong to it:
--
--   conversation_reservations.session_state
--       The state of the session a `session` reservation is for. The kernel
--       derives from it what the process may read and where it may send
--       (the session-state table of spec 2043 §5.3):
--         scheduled   messages addressed to the facilitator
--         live        every human message (needs the channel's readiness)
--         confirming  every human message
--         closed      nothing; the reservation is released
--         cancelled   nothing; the reservation is released
--       NULL for a `home` reservation and for agent discussions.
--   conversation_reservations.session_id
--       The plugin's id of that session, for the operator and the logs.
--
--   conversation_link_requests
--       A person addressed the facilitator INSIDE a conversation no process
--       of it reads, and the archetype plugin took the message as a request
--       to link that conversation to one of its processes. Only such a
--       request lets the process reserve the conversation as a session
--       conversation: the link is authorized from inside the target, never
--       from the home conversation (criterion 48). The message itself is not
--       stored; the plugin gets no read access before the link is taken.
--       A request is consumed by the reservation it authorized.
--
-- Idempotent (the CI schema job applies everything twice).

ALTER TABLE conversation_reservations ADD COLUMN IF NOT EXISTS session_state TEXT;
ALTER TABLE conversation_reservations ADD COLUMN IF NOT EXISTS session_id TEXT;

ALTER TABLE conversation_reservations DROP CONSTRAINT IF EXISTS conversation_reservations_session_state_check;
ALTER TABLE conversation_reservations ADD CONSTRAINT conversation_reservations_session_state_check
  CHECK (
    (role = 'home' AND session_state IS NULL)
    OR (role = 'session' AND (session_state IS NULL
        OR session_state IN ('scheduled', 'live', 'confirming', 'closed', 'cancelled')))
  );

CREATE TABLE IF NOT EXISTS conversation_link_requests (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plugin_id       TEXT NOT NULL,
  agent_id        UUID NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  channel_type    TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  -- The author as the channel stated it on the turn.
  principal_id    TEXT NOT NULL,
  message_id      TEXT,
  -- The caller's processes of the agent that could link a conversation when
  -- the request came in; the reservation names one of them.
  process_ids     TEXT[] NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL,
  consumed_at     TIMESTAMPTZ,
  reservation_id  UUID REFERENCES conversation_reservations (id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS conversation_link_requests_conversation_idx
  ON conversation_link_requests (channel_type, conversation_id);
CREATE INDEX IF NOT EXISTS conversation_link_requests_expiry_idx
  ON conversation_link_requests (expires_at) WHERE consumed_at IS NULL;
