-- ── Agent archetypes: registry + `agents.archetype` (#2088, #2060) ─────────
-- EXPAND step of the move from `agents.kind` (0067, a closed CHECK) to
-- `agents.archetype` with a registry. An agent has exactly one archetype, set
-- at creation and never switched; `standard` is built in, further archetypes
-- are registered (today `facilitator`, seeded here; from an archetype plugin
-- later).
--
-- `kind` STAYS, and stays equal. A machine that still runs the previous
-- release reads `kind`, and reads anything it does not recognise as
-- `standard`: after a plain rename it would run every facilitator as a
-- standard agent with all omissions off. So for as long as both columns
-- exist, an INSERT that names only one of them fills the other, and both are
-- fixed at creation. The contract step (drop `kind`) is its own migration,
-- after no reader of `kind` is left.
--
-- Applied twice by the CI schema job, so every statement is idempotent. The
-- backfill runs BEFORE the immutability trigger exists (the trigger is
-- dropped first on a second application) and only touches rows that still
-- carry the column default next to a non-default kind: on a second
-- application it matches nothing.

CREATE TABLE IF NOT EXISTS agent_archetypes (
  id          TEXT PRIMARY KEY CHECK (id ~ '^[a-z][a-z0-9-]{0,62}$'),
  -- Who registered it: 'kernel' (built in or kernel-seeded) or a plugin id.
  source      TEXT NOT NULL DEFAULT 'kernel',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE agent_archetypes IS
  '#2088 registry of agent archetypes. `standard` is built in; an agent references exactly one and never switches.';

INSERT INTO agent_archetypes (id, source) VALUES
  ('standard', 'kernel'),
  ('facilitator', 'kernel')
ON CONFLICT (id) DO NOTHING;

ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS archetype TEXT NOT NULL DEFAULT 'standard';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'agents_archetype_fkey'
       AND conrelid = 'agents'::regclass
  ) THEN
    ALTER TABLE agents
      ADD CONSTRAINT agents_archetype_fkey
      FOREIGN KEY (archetype) REFERENCES agent_archetypes (id);
  END IF;
END
$$;

COMMENT ON COLUMN agents.archetype IS
  '#2088 archetype of the agent (agent_archetypes.id). Fixed at creation (trigger agents_archetype_immutable). `kind` mirrors it until the contract step.';

-- Backfill, before the immutability trigger.
DROP TRIGGER IF EXISTS agents_archetype_immutable ON agents;

UPDATE agents
   SET archetype = kind
 WHERE archetype = 'standard'
   AND kind <> 'standard';

CREATE OR REPLACE FUNCTION agents_refuse_archetype_change() RETURNS trigger AS $$
BEGIN
  IF NEW.archetype IS DISTINCT FROM OLD.archetype THEN
    RAISE EXCEPTION 'agents.archetype is fixed at creation (agent %, % -> %)',
      OLD.slug, OLD.archetype, NEW.archetype
      USING ERRCODE = 'check_violation', CONSTRAINT = 'agents_archetype_immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER agents_archetype_immutable
  BEFORE UPDATE OF archetype ON agents
  FOR EACH ROW EXECUTE FUNCTION agents_refuse_archetype_change();

-- `kind` and `archetype` say the same thing on every new row. A writer names
-- one of them (the previous release: `kind`; this release: `archetype`) and
-- the other follows. Naming both with different values is refused. Both are
-- immutable afterwards, so equal at creation is equal for good.
CREATE OR REPLACE FUNCTION agents_sync_kind_archetype() RETURNS trigger AS $$
BEGIN
  IF NEW.archetype = NEW.kind THEN
    RETURN NEW;
  END IF;
  IF NEW.archetype = 'standard' THEN
    NEW.archetype := NEW.kind;
  ELSIF NEW.kind = 'standard' THEN
    NEW.kind := NEW.archetype;
  ELSE
    RAISE EXCEPTION 'agents.kind (%) and agents.archetype (%) disagree (agent %)',
      NEW.kind, NEW.archetype, NEW.slug
      USING ERRCODE = 'check_violation', CONSTRAINT = 'agents_kind_archetype_equal';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS agents_kind_archetype_sync ON agents;
CREATE TRIGGER agents_kind_archetype_sync
  BEFORE INSERT ON agents
  FOR EACH ROW EXECUTE FUNCTION agents_sync_kind_archetype();

-- The default-agent refusal of 0067 reads the archetype from now on (same
-- rows today; `kind` goes away in the contract step).
CREATE OR REPLACE FUNCTION settings_refuse_facilitator_fallback() RETURNS trigger AS $$
BEGIN
  IF NEW.fallback_agent_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM agents
     WHERE id = NEW.fallback_agent_id AND archetype = 'facilitator'
  ) THEN
    RAISE EXCEPTION 'a facilitator cannot be the default agent (agent id %)',
      NEW.fallback_agent_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'fallback_agent_not_facilitator';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- rollback:
--   (restore settings_refuse_facilitator_fallback from 0067: `kind = 'facilitator'`)
--   DROP TRIGGER IF EXISTS agents_kind_archetype_sync ON agents;
--   DROP FUNCTION IF EXISTS agents_sync_kind_archetype();
--   DROP TRIGGER IF EXISTS agents_archetype_immutable ON agents;
--   DROP FUNCTION IF EXISTS agents_refuse_archetype_change();
--   ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_archetype_fkey;
--   ALTER TABLE agents DROP COLUMN IF EXISTS archetype;
--   DROP TABLE IF EXISTS agent_archetypes;
