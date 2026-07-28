-- ── skill verdict cache + acknowledgements (Wave 8) ────────────────────────
-- Skill verdicts are derived artifacts keyed by content_hash plus verifier
-- identity, recomputed independently of the imported skill row. They live in a
-- sibling table (not crammed into `skills.frontmatter`) so recompute does not
-- rewrite the skill document blob, deterministic and model-backed verdicts can
-- coexist, and operator acknowledgements can survive verdict recomputes.
CREATE TABLE IF NOT EXISTS skill_verdicts (
  content_hash     TEXT NOT NULL,
  verifier_version TEXT NOT NULL,
  model_id         TEXT NOT NULL DEFAULT '',
  prompt_hash      TEXT NOT NULL DEFAULT '',
  severity         TEXT NOT NULL
                   CHECK (severity IN ('no_signals', 'flagged', 'high_risk', 'scan_failed', 'pending', 'too_large_to_scan')),
  risk_codes       JSONB NOT NULL DEFAULT '[]',
  rationale        TEXT,
  computed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (content_hash, verifier_version, model_id, prompt_hash)
);
CREATE INDEX IF NOT EXISTS skill_verdicts_lookup_idx
  ON skill_verdicts(content_hash, verifier_version);

-- Acks live separately so a verdict recompute does not delete operator review
-- state. The PK is intentionally scoped to (content_hash, verifier_version):
-- mandated design fix, because a content_hash-only key would let a stale ack
-- mask newly introduced risk signals after a verifier upgrade.
CREATE TABLE IF NOT EXISTS skill_verdict_acks (
  content_hash     TEXT NOT NULL,
  verifier_version TEXT NOT NULL,
  acked_by         TEXT NOT NULL,
  acked_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (content_hash, verifier_version)
);

-- rollback: DROP TABLE skill_verdict_acks; DROP TABLE skill_verdicts;
