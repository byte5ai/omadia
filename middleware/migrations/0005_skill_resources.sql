-- ── skill bundle resources (Wave 7) ─────────────────────────────────────────
-- A skill can carry bundled reference files beyond its body (Claude skills ship
-- a folder of resources; #391 extensibility step 2). Each resource is a named
-- text blob owned by a skill and cascade-deleted with it. Kept in its own table
-- (not frontmatter) so resources have their own lifecycle and don't bloat the
-- content_hash. Runtime load-on-demand for sub-agents is a separate step.
CREATE TABLE IF NOT EXISTS skill_resources (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  skill_id   UUID NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  content    TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (skill_id, name)
);
CREATE INDEX IF NOT EXISTS skill_resources_skill_idx ON skill_resources(skill_id);
