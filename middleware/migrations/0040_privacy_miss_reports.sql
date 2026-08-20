-- #760 — privacy miss-report review queue.
--
-- The prompt-masking layer's fail-closed guarantee covers execution failures,
-- not non-detection: a value neither C0 nor C1 recognizes leaves with the
-- prompt, silently. This table is the catch basin — an operator who notices a
-- missed value reports it ("this should have been masked"), an admin reviews
-- the queue and turns the term into a custom_terms deny-list entry.
--
-- Privacy posture: the reported term is stored as the REPORTER TYPED IT —
-- reporting is a deliberate operator act on an auth-gated surface, and the
-- literal value is exactly what the reviewer needs to build the deny-list
-- rule. The queue lives behind requireAuth like every operator surface.
--
-- Numbering: 0038 reserved (#746 Satellites), 0039 taken by #757
-- (turn_receipts, PR #763). This series continues at 0040.

CREATE TABLE IF NOT EXISTS privacy_miss_reports (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter     TEXT NOT NULL,
  term         TEXT NOT NULL,
  description  TEXT,
  turn_id      TEXT,
  status       TEXT NOT NULL DEFAULT 'open'
                 CHECK (status IN ('open', 'resolved')),
  resolved_by  TEXT,
  resolved_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS privacy_miss_reports_status_created
  ON privacy_miss_reports (status, created_at DESC);
