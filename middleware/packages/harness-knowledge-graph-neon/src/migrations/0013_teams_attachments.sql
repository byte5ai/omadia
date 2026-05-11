-- Persistence metadata for Teams message attachments. Blobs live in Tigris
-- under key `teams-attachments/<tenant>/<conversationId>/<turnIsoTime>-<sha256>.<ext>`;
-- this table indexes them for retrieval, search, and retention cleanup.
--
-- Access pattern:
--   - write-once on Teams activity inbound
--   - read by conversation / user for audit + bot feature lookup
--   - TTL cleanup via `created_at` column

CREATE TABLE IF NOT EXISTS teams_attachments (
  id                BIGSERIAL PRIMARY KEY,
  tenant            TEXT NOT NULL,
  conversation_id   TEXT NOT NULL,
  user_id           TEXT NULL,
  turn_time         TIMESTAMPTZ NULL,   -- Teams activity.timestamp; nullable for
                                        -- manual imports / tests
  storage_key       TEXT NOT NULL,       -- Tigris object key, unique
  file_name         TEXT NOT NULL,
  content_type      TEXT NOT NULL,
  size_bytes        BIGINT NOT NULL,
  sha256            TEXT NOT NULL,
  source            TEXT NOT NULL,       -- 'teams.file' | 'teams.inline_image' | 'other'
  source_url        TEXT NULL,           -- original signed download URL from Teams (short-lived, kept for audit)
  teams_unique_id   TEXT NULL,           -- content.uniqueId from Teams file-download-info
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_teams_attachments_storage_key
  ON teams_attachments (storage_key);

CREATE INDEX IF NOT EXISTS idx_teams_attachments_conversation
  ON teams_attachments (tenant, conversation_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_teams_attachments_created
  ON teams_attachments (tenant, created_at DESC);

-- sha256 index for duplicate-detection lookups (same file re-uploaded in
-- different conversations should be flaggable).
CREATE INDEX IF NOT EXISTS idx_teams_attachments_sha256
  ON teams_attachments (tenant, sha256);
