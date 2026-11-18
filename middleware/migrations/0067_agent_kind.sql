-- ── Agent kind: `standard` | `facilitator` (#2060, epic #2043) ──────────────
-- A facilitator is a kind of agent that only moderates: it inherits identity
-- and personality, and deliberately omits what would make it partial (business
-- grants, memory, consultation, being the default agent). The kernel enforces
-- the omissions in code; this migration carries the three facts the database
-- itself must never get wrong.
--
-- 1. `agents.kind`, closed vocabulary, default `standard`. Every existing row
--    is a standard agent, so nothing changes for it.
--
-- 2. THE KIND IS FIXED AT CREATION. A trigger refuses any UPDATE that changes
--    it. An agent that could switch kinds would carry memory, grants and
--    loyalties from its former life into a role that is defined by having
--    none (spec 2043 §2). A route check alone would not cover a hand-written
--    UPDATE or a future writer, and the damage would be silent.
--
-- 3. A FACILITATOR IS NEVER THE DEFAULT AGENT. The default agent answers every
--    unbound channel turn for whoever asks, which is exactly "serving a user".
--    Two triggers: one on `multi_orchestrator_settings` (pointing the fallback
--    at a facilitator), and the kind trigger above already covers the other
--    direction (turning the current fallback into a facilitator is a kind
--    change, which is refused).
--
-- The CHECK probe is scoped by `conrelid` (lesson of 0056).

ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'standard';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'agents_kind_check'
       AND conrelid = 'agents'::regclass
  ) THEN
    ALTER TABLE agents
      ADD CONSTRAINT agents_kind_check
      CHECK (kind IN ('standard', 'facilitator'));
  END IF;
END
$$;

COMMENT ON COLUMN agents.kind IS
  '#2060 kind of agent: standard | facilitator. Fixed at creation (trigger agents_kind_immutable).';

CREATE OR REPLACE FUNCTION agents_refuse_kind_change() RETURNS trigger AS $$
BEGIN
  IF NEW.kind IS DISTINCT FROM OLD.kind THEN
    RAISE EXCEPTION 'agents.kind is fixed at creation (agent %, % -> %)',
      OLD.slug, OLD.kind, NEW.kind
      USING ERRCODE = 'check_violation', CONSTRAINT = 'agents_kind_immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS agents_kind_immutable ON agents;
CREATE TRIGGER agents_kind_immutable
  BEFORE UPDATE OF kind ON agents
  FOR EACH ROW EXECUTE FUNCTION agents_refuse_kind_change();

CREATE OR REPLACE FUNCTION settings_refuse_facilitator_fallback() RETURNS trigger AS $$
BEGIN
  IF NEW.fallback_agent_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM agents
     WHERE id = NEW.fallback_agent_id AND kind = 'facilitator'
  ) THEN
    RAISE EXCEPTION 'a facilitator cannot be the default agent (agent id %)',
      NEW.fallback_agent_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'fallback_agent_not_facilitator';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS fallback_agent_not_facilitator ON multi_orchestrator_settings;
CREATE TRIGGER fallback_agent_not_facilitator
  BEFORE INSERT OR UPDATE OF fallback_agent_id ON multi_orchestrator_settings
  FOR EACH ROW EXECUTE FUNCTION settings_refuse_facilitator_fallback();

-- rollback:
--   DROP TRIGGER IF EXISTS fallback_agent_not_facilitator ON multi_orchestrator_settings;
--   DROP FUNCTION IF EXISTS settings_refuse_facilitator_fallback();
--   DROP TRIGGER IF EXISTS agents_kind_immutable ON agents;
--   DROP FUNCTION IF EXISTS agents_refuse_kind_change();
--   ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_kind_check;
--   ALTER TABLE agents DROP COLUMN IF EXISTS kind;
