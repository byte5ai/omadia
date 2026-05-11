-- Profile-Snapshots v1 (Phase 2.2 of the Kemia integration, OB-64).
--
-- Versioned, immutable captures of a profile's full state. Three tables:
--   * profile_snapshot         — one row per frozen profile state (metadata)
--   * profile_snapshot_asset   — bytes of every entry in the bundle ZIP
--   * profile_health_score     — drift metric over time vs. live state
--
-- Layout decisions:
--   * Bytes in BYTEA, not S3: bundles are capped at 50 MB (Phase 2.1).
--     Transactional consistency between snapshot row + asset bytes; no
--     Tigris round-trip per diff. TOAST handles the size transparently.
--   * UNIQUE (profile_id, bundle_hash) on profile_snapshot: idempotent
--     re-snapshot — the same live state produces the same hash, so the
--     service returns the existing row instead of creating a duplicate.
--   * is_deploy_ready as BOOLEAN, not enum: it's a 1-bit flag with audit
--     fields next to it. If we later need 'archived' / 'rolled-back'
--     states, this becomes an enum then.
--   * profile_health_score split out: a snapshot is immutable, but its
--     drift score against the live state changes over time as the live
--     state moves on. Separating prevents UPDATEs against immutable
--     snapshot rows. Phase 2.3 (Drift-Worker) writes here on a cron;
--     Phase 2.2 only writes one initial row at snapshot-create time.

CREATE TABLE IF NOT EXISTS profile_snapshot (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id          TEXT NOT NULL,
  profile_version     TEXT NOT NULL,
  bundle_hash         TEXT NOT NULL,
  manifest_yaml       TEXT NOT NULL,
  bundle_size_bytes   BIGINT NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by          TEXT NOT NULL,
  notes               TEXT,
  is_deploy_ready     BOOLEAN NOT NULL DEFAULT false,
  deploy_ready_at     TIMESTAMPTZ,
  deploy_ready_by     TEXT,
  UNIQUE (profile_id, bundle_hash)
);

CREATE INDEX IF NOT EXISTS idx_profile_snapshot_profile
  ON profile_snapshot(profile_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_profile_snapshot_deploy_ready
  ON profile_snapshot(profile_id, is_deploy_ready)
  WHERE is_deploy_ready;

CREATE TABLE IF NOT EXISTS profile_snapshot_asset (
  snapshot_id   UUID NOT NULL REFERENCES profile_snapshot(id) ON DELETE CASCADE,
  path          TEXT NOT NULL,
  content       BYTEA NOT NULL,
  sha256        TEXT NOT NULL,
  size_bytes    INTEGER NOT NULL,
  PRIMARY KEY (snapshot_id, path)
);

CREATE TABLE IF NOT EXISTS profile_health_score (
  id                BIGSERIAL PRIMARY KEY,
  snapshot_id       UUID NOT NULL REFERENCES profile_snapshot(id) ON DELETE CASCADE,
  computed_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  drift_score       NUMERIC(5,4) NOT NULL,
  diverged_assets   JSONB NOT NULL DEFAULT '[]'::jsonb,
  notes             TEXT
);

CREATE INDEX IF NOT EXISTS idx_profile_health_score_snapshot
  ON profile_health_score(snapshot_id, computed_at DESC);
