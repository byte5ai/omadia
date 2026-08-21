-- #330 C2a — ephemeral attachments: the conversation binding and the
-- per-conversation initiator role that were auto-provisioned for a
-- facilitation live exactly as long as its ephemeral workflow. This table is
-- the reaper's back-channel: on reap (terminal state or TTL) the kernel's
-- onEphemeralReaped callback reads the rows, removes the channel binding,
-- closes the role holders, and deletes the rows.
--
-- 'pending' rows exist between the bot_added auto-bind and facilitation_start
-- (no workflow yet); a sweep expires them so an invite that never starts a
-- facilitation cannot hold a group binding forever. Deliberately NO FK onto
-- conductor_workflows: hard-delete order must stay free, and a dangling
-- workflow_id only ever makes a row eligible for cleanup.

CREATE TABLE IF NOT EXISTS conductor_ephemeral_attachments (
  id            BIGSERIAL PRIMARY KEY,
  workflow_id   TEXT,
  agent_slug    TEXT NOT NULL,
  channel_type  TEXT NOT NULL,
  channel_key   TEXT NOT NULL,
  role_key      TEXT,
  state         TEXT NOT NULL DEFAULT 'pending',
  expires_at    TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (channel_type, channel_key)
);

ALTER TABLE conductor_ephemeral_attachments DROP CONSTRAINT IF EXISTS conductor_ephemeral_attachments_state_check;
ALTER TABLE conductor_ephemeral_attachments ADD CONSTRAINT conductor_ephemeral_attachments_state_check
  CHECK (state IN ('pending', 'attached'));

CREATE INDEX IF NOT EXISTS conductor_ephemeral_attachments_workflow_idx
  ON conductor_ephemeral_attachments (workflow_id) WHERE workflow_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS conductor_ephemeral_attachments_expiry_idx
  ON conductor_ephemeral_attachments (expires_at) WHERE state = 'pending';
