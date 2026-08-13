-- Omadia Conductor — DB-backed workflow templates (issue #478, templates v2).
-- User-authored TemplateManifests with immutable versions, an anonymous
-- instantiation counter (modeled on 0009_mcp_call_log.sql: denormalized name,
-- no payloads, no per-user tracking), and template provenance on workflows.
-- Forward-only, idempotent (IF NOT EXISTS); runs in the migrator's transaction.
--
-- `status` is a growable enum ('private' | 'pending' | 'shared') — deliberately
-- NO CHECK constraint (#470 review lesson: CHECKs on growable enumerations force
-- an ALTER on every new state).

CREATE TABLE IF NOT EXISTS conductor_templates (
  id             TEXT PRIMARY KEY,
  created_by     TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'private',
  latest_version INTEGER NOT NULL DEFAULT 1,
  reviewed_by    TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Immutable manifest snapshots, mirroring the conductor_workflow_versions shape:
-- a version row is never updated, publishing appends the next number.
CREATE TABLE IF NOT EXISTS conductor_template_versions (
  template_id TEXT NOT NULL REFERENCES conductor_templates(id) ON DELETE CASCADE,
  version     INTEGER NOT NULL,
  manifest    JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (template_id, version)
);

-- Append-only telemetry: one row per instantiation. template_id is NOT a FK and
-- template_name is denormalized so rows survive template deletion (the
-- 0009_mcp_call_log pattern). Also counts bundled/plugin template ids.
CREATE TABLE IF NOT EXISTS conductor_template_instantiations (
  id               BIGSERIAL PRIMARY KEY,
  template_id      TEXT,
  template_name    TEXT NOT NULL,
  template_version INTEGER NOT NULL,
  workflow_slug    TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS conductor_template_instantiations_template_id_idx
  ON conductor_template_instantiations(template_id);

-- Provenance: which template (and manifest version) a workflow was instantiated
-- from. Copy-not-reference stands — these columns are informational (update
-- hints), never dereferenced at run time.
ALTER TABLE conductor_workflows ADD COLUMN IF NOT EXISTS template_id TEXT;
ALTER TABLE conductor_workflows ADD COLUMN IF NOT EXISTS template_version INTEGER;
