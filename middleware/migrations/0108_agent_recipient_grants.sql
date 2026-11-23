-- ── Recipient grants: explicit targets of proactive messages (spec 2042 §5.12) ──
-- A proactive message goes to the context its trigger was created in, or to
-- an explicit target "that is allowed by a recipient grant and passes the
-- discretion check for the recipient at send time" (criterion 24).
--
--   agent_recipient_grants  one row per (agent, conversation) an operator
--                           allowed as a target of that agent's proactive
--                           messages. `delivery_ref` is the channel's opaque
--                           conversation reference the message goes through.
--                           A revoked grant is deleted (the admin audit keeps
--                           who granted and revoked what); a trigger whose
--                           target lost its grant delivers nothing.
--
-- Idempotent (the CI schema job applies everything twice).

CREATE TABLE IF NOT EXISTS agent_recipient_grants (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id        UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  channel         TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  delivery_ref    JSONB NOT NULL,
  label           TEXT,
  granted_by      TEXT NOT NULL,
  granted_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT agent_recipient_grants_unique UNIQUE (agent_id, channel, conversation_id)
);
