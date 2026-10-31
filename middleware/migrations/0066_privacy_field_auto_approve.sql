-- Field classification — auto-approval and bulk accept.
--
-- 0065 stored suggestions for an admin to confirm one by one. Two additions:
--
--   * Auto-approval (privacy guard setting `auto_approve_non_personal`,
--     default on): the recompute writes the scoped `non_personal_fields`
--     entry itself for a field whose every relation target is a known
--     non-personal model, or whose schema-only verdict is non-personal above
--     `auto_approve_confidence` AND whose values the name detector vetted
--     clean. Recorded as decision `auto_approve` (actor
--     `system:auto-classifier`), status `auto_approved`. A field that drifts
--     to a person model, a detector hit / near-miss or conflicting targets is
--     taken out again: decision `auto_revoke`, status `auto_revoked`.
--   * Bulk accept: an admin confirms every open suggestion at once. Each field
--     gets decision `confirm` with the batch's id in `decision_batch_id`; the
--     batch row lists exactly the entries it wrote, so the latest batch can be
--     undone entry by entry.
--
-- Privacy posture unchanged: no column here holds a field value. A batch's
-- `entries` are candidate ids and `non_personal_fields` entries (tool, scope,
-- field path) only.
--
-- Idempotent: the CHECK constraints are dropped (IF EXISTS) and re-added
-- under the names Postgres gave 0065's inline constraints; columns, tables
-- and indexes use IF NOT EXISTS.

ALTER TABLE privacy_field_candidates
  DROP CONSTRAINT IF EXISTS privacy_field_candidates_status_check;
ALTER TABLE privacy_field_candidates
  ADD CONSTRAINT privacy_field_candidates_status_check
  CHECK (status IN ('suggested', 'needs_clarification', 'personal',
                    'confirmed', 'confirmed_conflict', 'rejected',
                    'kept_masked', 'auto_approved', 'auto_revoked'));

ALTER TABLE privacy_field_candidates
  DROP CONSTRAINT IF EXISTS privacy_field_candidates_decision_check;
ALTER TABLE privacy_field_candidates
  ADD CONSTRAINT privacy_field_candidates_decision_check
  CHECK (decision IS NULL OR decision IN ('confirm', 'reject', 'keep_masked', 'revert',
                                          'auto_approve', 'auto_revoke'));

-- The bulk batch a `confirm` (or its undo `revert`) belongs to; NULL for a
-- decision on one field.
ALTER TABLE privacy_field_candidates
  ADD COLUMN IF NOT EXISTS decision_batch_id UUID;

-- "N fields auto-approved since your last visit".
CREATE INDEX IF NOT EXISTS privacy_field_candidates_auto_decided
  ON privacy_field_candidates (decided_at)
  WHERE decision = 'auto_approve';

CREATE TABLE IF NOT EXISTS privacy_field_bulk_batches (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id     TEXT,
  actor_email  TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  undone_at    TIMESTAMPTZ,
  undone_by    TEXT,
  -- [{ "candidateId": "<uuid>", "entry": "<tool>:<scope>/<field>" }]
  entries      JSONB NOT NULL
);

CREATE INDEX IF NOT EXISTS privacy_field_bulk_batches_open
  ON privacy_field_bulk_batches (created_at DESC)
  WHERE undone_at IS NULL;
