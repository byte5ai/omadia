-- ── #2319 / ADR-0290 / ADR-0355 — the credential broker as a granted capability ──
--
--   agent_credential_grants     one row per (agent, credential) an operator
--                               allowed that agent to reach through the
--                               kernel capability `credentialBroker@1`
--                               (`credential_request`, `credential_ask`). No
--                               row, no tools: the capability is never on by
--                               default and never "all credentials". The
--                               per-principal `credential_grants` row of
--                               ADR-0102 is still required on every call; this
--                               table only narrows which credentials an agent
--                               may name at all. A revoked grant is deleted
--                               (the admin audit keeps who granted and revoked).
--
--   credential_ask_deliveries   where the answer to an agent's ask goes: the
--                               conversation the asking turn ran in, as the
--                               channel's opaque reference. Written by the
--                               `credential_ask` tool, read and deleted when
--                               the owner approves or denies. Never part of
--                               the ask itself, so the owner-only ask rules
--                               of 0043 stay untouched.
--
-- Idempotent (the CI schema job applies everything twice).

CREATE TABLE IF NOT EXISTS agent_credential_grants (
  agent_id      UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  credential_id UUID NOT NULL REFERENCES credentials(id) ON DELETE CASCADE,
  granted_by    TEXT NOT NULL,
  granted_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, credential_id)
);

CREATE INDEX IF NOT EXISTS agent_credential_grants_credential
  ON agent_credential_grants (credential_id);

CREATE TABLE IF NOT EXISTS credential_ask_deliveries (
  ask_id           UUID PRIMARY KEY REFERENCES credential_asks(id) ON DELETE CASCADE,
  agent_id         UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  channel          TEXT NOT NULL,
  conversation_ref JSONB NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- An agent's ask states how long the grant should last counted from the
-- owner's APPROVAL (`credential_ask` `valid_minutes`); `requested_grant_expires_at`
-- stays the upper bound. NULL for asks that state only an absolute expiry.
ALTER TABLE credential_asks
  ADD COLUMN IF NOT EXISTS requested_grant_valid_seconds INTEGER
    CHECK (requested_grant_valid_seconds IS NULL OR requested_grant_valid_seconds > 0);

CREATE INDEX IF NOT EXISTS credential_ask_deliveries_agent
  ON credential_ask_deliveries (agent_id);
