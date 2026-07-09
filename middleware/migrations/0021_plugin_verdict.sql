-- ── plugin code-scan verdicts (issue #453) ─────────────────────────────────
-- Verdicts produced by the SkillSpector code scanner over executable plugin
-- packages. Keyed on the ingested ZIP's sha256 (`content_hash`) plus the
-- scanner identity (`verifier_version`), mirroring `0007_skill_verdict.sql`,
-- so re-installs of an identical package are a cache hit and a scanner
-- upgrade recomputes without losing history for the old version.
--
-- Unlike skill verdicts, the operator acknowledgement lives inline
-- (`ack_by` / `ack_at`): the upsert path only ever rewrites the scan columns
-- (severity, findings, rationale, computed_at), so an ack survives a
-- re-scan under the same verifier_version, and a verifier upgrade
-- (new verifier_version → new row) correctly invalidates the ack.
--
-- Advisory-only in v1: nothing reads this table to block an install.
CREATE TABLE IF NOT EXISTS plugin_verdicts (
  content_hash     TEXT NOT NULL,
  verifier_version TEXT NOT NULL,
  plugin_id        TEXT NOT NULL,
  severity         TEXT NOT NULL
                   CHECK (severity IN ('no_signals', 'flagged', 'high_risk', 'scan_failed', 'pending', 'too_large_to_scan')),
  findings         JSONB NOT NULL DEFAULT '[]',
  scanner_version  TEXT NOT NULL DEFAULT '',
  rationale        TEXT,
  computed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  ack_by           TEXT,
  ack_at           TIMESTAMPTZ,
  PRIMARY KEY (content_hash, verifier_version)
);

-- Store/detail pages look verdicts up by plugin id (latest install wins).
CREATE INDEX IF NOT EXISTS plugin_verdicts_plugin_idx
  ON plugin_verdicts(plugin_id, computed_at DESC);

-- rollback: DROP TABLE plugin_verdicts;
