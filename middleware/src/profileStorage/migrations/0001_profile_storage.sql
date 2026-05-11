-- Profile-Storage v1 (Phase 2.1.5 of the Kemia integration).
--
-- Stores the live (operator-edited) state of a profile's free-form artefacts:
-- the agent.md prose body and the knowledge/* attachments. Plugin pins live
-- in installedRegistry.installed_version and are NOT mirrored here — this
-- table is only the profile-owned, byte-shaped content.
--
-- Bytes live in BYTEA, not S3 / disk. Rationale (see HANDOFF
-- docs/harness-platform/HANDOFF-2026-05-07-kemia-phase-2.1.5-profile-storage.md):
--   * Profile bundles are bounded by the 50 MB Bundle-Cap from Phase 2.1
--   * Snapshots (Phase 2.2 / OB-64) need transactional consistency between
--     metadata and asset bytes — same JVM/process, single Postgres
--   * No DATA_DIR sync problem on multi-replica Fly deployments

CREATE TABLE IF NOT EXISTS profile_agent_md (
  profile_id  TEXT PRIMARY KEY,
  content     BYTEA NOT NULL,
  sha256      TEXT NOT NULL,
  size_bytes  INTEGER NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  TEXT NOT NULL
);

-- Knowledge files are flat (no path layout) — consistent with the bundle
-- spec (profileBundleZipper enforces flat filenames + extension allowlist).
CREATE TABLE IF NOT EXISTS profile_knowledge_file (
  profile_id  TEXT NOT NULL,
  filename    TEXT NOT NULL,
  content     BYTEA NOT NULL,
  sha256      TEXT NOT NULL,
  size_bytes  INTEGER NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  TEXT NOT NULL,
  PRIMARY KEY (profile_id, filename)
);

CREATE INDEX IF NOT EXISTS idx_profile_knowledge_file_profile
  ON profile_knowledge_file(profile_id);
