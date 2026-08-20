-- Issue #576 P3 — durable per-scope sandbox registry.
--
-- Bookkeeping `DockerSandboxBackend`'s deterministic container naming does
-- not give for free: last-used timestamps for the idle reaper (reaper.ts),
-- the RO-layer content hash last synced into each scope's sandbox
-- (contentHash.ts), and — once a second backend exists — a scope->backend
-- routing table. One row per LIVE scope sandbox; a reaped or torn-down
-- scope's row is deleted, not soft-deleted (nothing here is an audit log).
--
-- Migration numbering note: 0040-0042 are occupied by concurrent
-- credential-work PRs (#769/#772) as of this migration's authoring, with an
-- observed numbering collision at 0040 (three files) unrelated to #576.
-- 0044 was chosen with margin over that, per the phase-4b plan's guidance
-- to leave room for in-flight PRs.

CREATE TABLE IF NOT EXISTS sandbox_registry (
  scope_key      TEXT PRIMARY KEY,
  backend        TEXT NOT NULL,
  sandbox_ref    TEXT NOT NULL,
  profile        JSONB NOT NULL,
  ro_layer_hash  TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The reaper sweeps by last_used_at; an index keeps that scan cheap once
-- the table has more than a handful of rows.
CREATE INDEX IF NOT EXISTS sandbox_registry_last_used_at_idx
  ON sandbox_registry (last_used_at);
