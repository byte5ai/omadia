-- ── skill lifecycle foundation (Wave 0) ─────────────────────────────────────
-- Two provenance/identity columns that unblock the skill import + lifecycle
-- work (#391 / #397):
--   content_hash — deterministic sha256 over the skill's canonical
--     {frontmatter + body}. Drives re-import dedup / convergence (#391) and
--     re-version-on-change (#397). Nullable so pre-existing rows backfill
--     lazily on their next write.
--   forked_from  — provenance link set when an imported (source='file') skill
--     is forked into an editable source='db' copy (fork-on-edit, #397). NULL
--     for skills that were never forked.
ALTER TABLE skills ADD COLUMN IF NOT EXISTS content_hash TEXT;
ALTER TABLE skills ADD COLUMN IF NOT EXISTS forked_from  UUID REFERENCES skills(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS skills_content_hash_idx ON skills(content_hash);
CREATE INDEX IF NOT EXISTS skills_forked_from_idx  ON skills(forked_from);
