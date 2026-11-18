-- #1556 follow-up — field classification for the privacy guard's
-- `non_personal_fields` setting.
--
-- The privacy guard observes which masked fields its tools return, per
-- source: the tool and the scope its rows belong to (an Odoo model, an
-- uploaded dataset's id, or `-` when the result names none). The kernel
-- resolves what each field points to (Odoo `fields_get` on the scope model,
-- schema only) or asks the guard's small model about the source's schema,
-- classifies it and stores the CANDIDATE here for an admin to confirm,
-- reject or keep masked. Nothing is ever added to the setting without an
-- admin's confirm.
--
-- Privacy posture: these tables hold tool names, scopes, field paths and
-- labels (schema), Odoo model names, counts and detector verdicts — never a
-- field value. `reasons` and
-- `sample_verdict` carry codes, model names, counts and detector types only;
-- `masked_preview` holds shape-masked strings without a letter or digit.
--
-- Idempotent (IF NOT EXISTS) like every migration in this series.

CREATE TABLE IF NOT EXISTS privacy_field_candidates (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tool_name              TEXT NOT NULL,
  -- An Odoo model (`hr.employee`), a dataset id, or `-` (no model named).
  scope                  TEXT NOT NULL DEFAULT '-',
  field_path             TEXT NOT NULL,
  -- The field's schema label where the source has one (Odoo field string).
  label                  TEXT,
  -- Relation targets of this scope model's field (Odoo `fields_get`).
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
  UNIQUE (tool_name, scope, field_path)
);

CREATE INDEX IF NOT EXISTS privacy_field_candidates_status
  ON privacy_field_candidates (status);

-- Schema-only verdicts (the privacy guard's small model), cached 30 days by
-- the recompute: Odoo relation targets the built-in catalog does not know
-- (`x_custom.region`), and sources without relation metadata, keyed
-- `<tool>:<scope>` (`query_dataset:<uuid>`, `some_mcp_tool:-`).
CREATE TABLE IF NOT EXISTS privacy_model_verdicts (
  model       TEXT PRIMARY KEY,
  verdict     TEXT NOT NULL CHECK (verdict IN ('personal', 'non-personal', 'uncertain')),
  source      TEXT NOT NULL CHECK (source IN ('builtin', 'haiku')),
  confidence  DOUBLE PRECISION NOT NULL DEFAULT 0,
  reason      TEXT NOT NULL DEFAULT '',
  -- For a source verdict: a hash of the field paths it was asked about, so a
  -- new field re-asks instead of inheriting a verdict that never saw it.
  -- Empty for relation targets.
  fields_hash TEXT NOT NULL DEFAULT '',
  decided_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- When each admin last opened the page, for "N new since your last visit".
CREATE TABLE IF NOT EXISTS privacy_field_classification_visits (
  actor       TEXT PRIMARY KEY,
  visited_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
