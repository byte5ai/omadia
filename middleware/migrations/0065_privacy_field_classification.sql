-- #1556 follow-up — field classification for the privacy guard's
-- `non_personal_fields` setting.
--
-- The privacy guard observes which masked fields its Odoo tools return; the
-- kernel resolves what each field points to (Odoo `fields_get`, schema only),
-- classifies it and stores the CANDIDATE here for an admin to confirm,
-- reject or keep masked. Nothing is ever added to the setting without an
-- admin's confirm.
--
-- Privacy posture: these tables hold tool names, field paths, Odoo model
-- names, counts and detector verdicts — never a field value. `reasons` and
-- `sample_verdict` carry codes, model names, counts and detector types only;
-- `masked_preview` holds shape-masked strings without a letter or digit.
--
-- Idempotent (IF NOT EXISTS) like every migration in this series.

CREATE TABLE IF NOT EXISTS privacy_field_candidates (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tool_name              TEXT NOT NULL,
  field_path             TEXT NOT NULL,
  source_models          TEXT[] NOT NULL DEFAULT '{}',
  relation_models        TEXT[] NOT NULL DEFAULT '{}',
  value_shape            TEXT NOT NULL
                           CHECK (value_shape IN ('m2o', 'text', 'mixed')),
  status                 TEXT NOT NULL DEFAULT 'needs_clarification'
                           CHECK (status IN ('suggested', 'needs_clarification', 'personal',
                                             'confirmed', 'confirmed_conflict', 'rejected',
                                             'kept_masked')),
  reasons                JSONB NOT NULL DEFAULT '[]'::jsonb,
  fingerprint            TEXT NOT NULL DEFAULT '',
  sample_verdict         JSONB,
  -- Shape-masked preview strings from the guard (allowlist: whitespace and
  -- `& - . , / ( ) ' : +` kept, every other code point replaced by `•`).
  -- Taken BEFORE vetting,
  -- which drops the guard's sample. Carries no value.
  masked_preview         TEXT[] NOT NULL DEFAULT '{}',
  decision               TEXT
                           CHECK (decision IS NULL OR decision IN ('confirm', 'reject', 'keep_masked', 'revert')),
  decision_fingerprint   TEXT,
  decided_by_id          TEXT,
  decided_by_email       TEXT,
  decided_at             TIMESTAMPTZ,
  first_seen_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  seen_count             INTEGER NOT NULL DEFAULT 0,
  computed_at            TIMESTAMPTZ,
  last_status_change_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tool_name, field_path)
);

CREATE INDEX IF NOT EXISTS privacy_field_candidates_status
  ON privacy_field_candidates (status);

-- Schema-only verdicts on Odoo models the built-in catalog does not know
-- (the privacy guard's small model). Cached 30 days by the recompute.
CREATE TABLE IF NOT EXISTS privacy_model_verdicts (
  model       TEXT PRIMARY KEY,
  verdict     TEXT NOT NULL CHECK (verdict IN ('personal', 'non-personal', 'uncertain')),
  source      TEXT NOT NULL CHECK (source IN ('builtin', 'haiku')),
  confidence  DOUBLE PRECISION NOT NULL DEFAULT 0,
  reason      TEXT NOT NULL DEFAULT '',
  decided_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- When each admin last opened the page, for "N new since your last visit".
CREATE TABLE IF NOT EXISTS privacy_field_classification_visits (
  actor       TEXT PRIMARY KEY,
  visited_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
