-- #2296 / ADR-0295 — process ids no longer carry the title.
--
-- Until now a process id was `process:<scope>:<slug(title)>`. Since stored
-- processes hold the user's real values (ADR-0191 applied to processes), the
-- slug would carry them into an id the model reads. New processes get
-- `process:<uuid>`; this migration rewrites every existing id the same way and
-- keeps the old one in `legacy_id`, so a lookup by an id a transcript or a
-- plan still names resolves, and label stores keyed by the old id (the
-- discretion labels of 0112 in the core series) stay reachable.
--
-- process_history rows follow their process. History rows of a process that
-- no longer exists keep their id (nothing can name them any more).
--
-- Idempotent: only rows without a `legacy_id` whose id is not already of the
-- opaque form are rewritten.

ALTER TABLE processes ADD COLUMN IF NOT EXISTS legacy_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_processes_legacy_id
  ON processes (tenant_id, legacy_id)
  WHERE legacy_id IS NOT NULL;

WITH remap AS MATERIALIZED (
  SELECT tenant_id,
         id AS old_id,
         'process:' || gen_random_uuid()::text AS new_id
    FROM processes
   WHERE legacy_id IS NULL
     AND id !~ '^process:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
),
history AS (
  UPDATE process_history h
     SET id = r.new_id
    FROM remap r
   WHERE h.tenant_id = r.tenant_id
     AND h.id = r.old_id
)
UPDATE processes p
   SET id = r.new_id,
       legacy_id = r.old_id
  FROM remap r
 WHERE p.tenant_id = r.tenant_id
   AND p.id = r.old_id;

COMMENT ON COLUMN processes.legacy_id IS
  '#2296 / ADR-0295: the pre-0040 id process:<scope>:<slug>; lookups by it still resolve.';
