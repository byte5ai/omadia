-- ── The emission type of an authorized action (#2090, spec 2042 §5.5) ─────
-- Every action names what it produces: `prose` (model-written text),
-- `template` (a registered template filled with engine values) or `data`.
-- NULL = an authorization from before this column, or an action that
-- produces nothing (a check).
--
-- Idempotent (the CI schema job applies everything twice).

ALTER TABLE execution_authorizations ADD COLUMN IF NOT EXISTS emission TEXT;

ALTER TABLE execution_authorizations DROP CONSTRAINT IF EXISTS execution_authorizations_emission_check;
ALTER TABLE execution_authorizations ADD CONSTRAINT execution_authorizations_emission_check
  CHECK (emission IS NULL OR emission IN ('prose', 'template', 'data'));
