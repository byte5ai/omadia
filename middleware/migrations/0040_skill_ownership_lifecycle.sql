-- #577 P1 — skill ownership + lifecycle model.
--
-- Today's `skills` table (0003) is a flat registry row: no owner, no
-- lifecycle, no tamper-evidence. #577 turns a skill into a scope-owned,
-- shareable artifact by adding four columns:
--
--   owner_scope        — the skill's HOME, as a `ScopeId` wire string
--     (`personal:<userId>` / `group:<groupRef>` / `org:<orgId>` — see
--     `@omadia/channel-sdk` `formatSessionScope`). Only these three kinds are
--     valid skill owners (enforced in application code by
--     `isSkillOwnerScope`, not by a CHECK — the wire grammar lives in the
--     channel-sdk package, not SQL). NULLable: pre-existing rows (imported
--     via the file-import pipeline, #391) predate ownership and stay
--     unowned until a later migration step assigns them a home — same
--     "nullable, backfills lazily" posture as `content_hash` in 0004.
--   lifecycle_status    — `draft → reviewed → published → archived`
--     (#577 Kernkonzept #2). Defaults every row, existing and new, to
--     `draft` — publishing is an explicit, gated action
--     (`skillLifecycle.ts`), never an implicit consequence of this migration.
--   manifest_signature / manifest_signed_at — the HMAC-SHA256 signature over
--     the skill's canonical manifest (`skillLifecycle.ts` `canonicalSkillManifest`)
--     and when it was computed. NULL until the first lifecycle transition
--     signs the row. Tamper evidence: any of slug / name / owner_scope /
--     lifecycle_status / content_hash / requiredCapabilities changing without
--     a re-sign is what review/promote (#577 P3) will refuse.
--
-- Deliberately NOT added here: a `required_capabilities` column. Frontmatter
-- already carries it (`frontmatter.requiredCapabilities`, #577 Kernkonzept
-- #1) and `skillLifecycle.ts` reads it from there — a second column would be
-- a second source of truth for the same fact.

ALTER TABLE skills ADD COLUMN IF NOT EXISTS owner_scope TEXT;

ALTER TABLE skills ADD COLUMN IF NOT EXISTS lifecycle_status TEXT
  NOT NULL DEFAULT 'draft'
  CHECK (lifecycle_status IN ('draft', 'reviewed', 'published', 'archived'));

ALTER TABLE skills ADD COLUMN IF NOT EXISTS manifest_signature TEXT;
ALTER TABLE skills ADD COLUMN IF NOT EXISTS manifest_signed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS skills_owner_scope_idx ON skills(owner_scope);
CREATE INDEX IF NOT EXISTS skills_lifecycle_status_idx ON skills(lifecycle_status);

-- rollback: ALTER TABLE skills DROP COLUMN IF EXISTS manifest_signed_at; ALTER TABLE skills DROP COLUMN IF EXISTS manifest_signature; ALTER TABLE skills DROP COLUMN IF EXISTS lifecycle_status; ALTER TABLE skills DROP COLUMN IF EXISTS owner_scope;
