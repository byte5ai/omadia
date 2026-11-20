-- #2088 / #2067 (K6, the contract step of the archetype migration).
--
-- 0070 put `agents.archetype` next to `agents.kind` and kept the two equal
-- with a trigger, so an image from before archetypes could still read and
-- write `kind`. Every reader decides on `archetype` since then, and no
-- supported image writes `kind` any more: the column, the trigger that kept
-- it in step, and the guard of 0067 that made it immutable go.
--
-- The immutability of the archetype itself is 0070's own trigger
-- (`agents_archetype_immutable`); it stays. The guard on the fallback agent
-- reads `archetype` since 0070.
--
-- An image from before this migration keeps working against the dropped
-- column: it inserts `archetype` only and reads `kind` as absent, which it
-- resolves through `archetype`.

-- Each trigger goes together with the function it runs, and only that one:
-- a function is found through the search path, and one of the same name in
-- another schema may still serve a table there. A function that another
-- trigger still uses stays.
DO $$
DECLARE
  target RECORD;
  fn OID;
BEGIN
  FOR target IN
    SELECT * FROM (VALUES ('agents_kind_archetype_sync'), ('agents_kind_immutable')) AS t(trigger_name)
  LOOP
    SELECT tgfoid INTO fn FROM pg_trigger
     WHERE tgrelid = 'agents'::regclass AND tgname = target.trigger_name AND NOT tgisinternal;
    IF FOUND THEN
      EXECUTE format('DROP TRIGGER %I ON agents', target.trigger_name);
      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgfoid = fn) THEN
        EXECUTE format('DROP FUNCTION %s', fn::regprocedure);
      END IF;
    END IF;
  END LOOP;
END $$;

ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_kind_check;
ALTER TABLE agents DROP COLUMN IF EXISTS kind;
