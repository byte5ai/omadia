-- ── Kernel-issued grants for mail and calendar (#2078, spec 2043 §5.11) ────
-- A facilitator holds no business capabilities. Closing and following up
-- still need three narrow ones, on the instance's own integrations (for
-- Microsoft 365 the M365 connector):
--
--   protocol_dispatch    send one final protocol to its recipients
--   followup_scheduling  free/busy and invitations for one agreed meeting
--   followup_reminders   reminders to the owners of open action items
--
-- Until now the engine passed the allowed recipients to the connector and
-- the connector checked them: the party that wanted to send also said to
-- whom it may. A grant is issued by the kernel, bound to one execution scope,
-- and the connector asks the kernel before every operation.
--
--   execution_grants      one row per grant. It is LIVE only while its scope
--                         is open, inside its deadline and not stopped, it
--                         has not expired and was not revoked. Ending the
--                         scope (stop, abort, end of service, uninstall)
--                         therefore ends its grants in the same statement.
--   execution_grant_uses  one row per verification the connector asked for,
--                         allowed or refused: the audit of every use.
--
-- Idempotent (the CI schema job applies everything twice).

CREATE TABLE IF NOT EXISTS execution_grants (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_id      UUID NOT NULL REFERENCES execution_scopes (id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,
  -- What the grant is for: the protocol document, the agreed meeting.
  subject       TEXT NOT NULL DEFAULT '',
  -- Mail addresses the grant covers, lower-cased.
  recipients    JSONB NOT NULL DEFAULT '[]'::jsonb,
  issued_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL,
  revoked_at    TIMESTAMPTZ,
  revoke_reason TEXT,
  CONSTRAINT execution_grants_kind_check
    CHECK (kind IN ('protocol_dispatch', 'followup_scheduling', 'followup_reminders'))
);
-- One grant of a kind per scope and subject, ever.
CREATE UNIQUE INDEX IF NOT EXISTS execution_grants_once_idx
  ON execution_grants (scope_id, kind, subject);

CREATE TABLE IF NOT EXISTS execution_grant_uses (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  grant_id    UUID NOT NULL REFERENCES execution_grants (id) ON DELETE CASCADE,
  operation   TEXT NOT NULL,
  recipients  JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- The plugin that asked (the connector).
  asked_by    TEXT NOT NULL,
  allowed     BOOLEAN NOT NULL,
  refusal     TEXT,
  used_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS execution_grant_uses_grant_idx
  ON execution_grant_uses (grant_id, used_at);
