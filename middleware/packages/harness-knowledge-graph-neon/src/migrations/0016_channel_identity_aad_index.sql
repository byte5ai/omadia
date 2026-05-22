BEGIN;

-- Slice 1b-channel-web follow-up — index the AAD object id on
-- ChannelIdentity nodes so the resolver's cross-channel oid match
-- (`resolveOrCreateChannelIdentity`) hits an index instead of scanning
-- the JSONB column.
--
-- Partial: only ChannelIdentity rows that actually carry an oid (entra-
-- backed identities) appear in the index, keeping it small even with
-- many anonymous Telegram users.
--
-- Additive — no DDL changes, just a CREATE INDEX. Safe to apply on a
-- non-empty graph_nodes table.

CREATE INDEX IF NOT EXISTS idx_channel_identity_aad_oid
  ON graph_nodes (tenant_id, (properties->>'aadObjectId'))
  WHERE type = 'ChannelIdentity'
    AND properties->>'aadObjectId' IS NOT NULL;

COMMIT;
