-- ── Default agents per user and channel, or off (#2055, spec 2042 §5.6) ────
-- The management layer answers an unaddressed message (no own channel
-- identity, no explicit address, no selection, no binding) from this table.
-- An entry names an agent or is `off` (agent_id NULL). Entries are evaluated
-- in exactly this order, the first one that exists wins, `off` included:
--
--   (principal, channel_type)   one person in one channel
--   (principal, NULL)           one person everywhere
--   (NULL, channel_type)        everyone in one channel
--   (NULL, NULL)                the instance
--
-- `off` means no agent answers; the sender gets a `system` notice how to
-- reach one. There is no fallback agent any more: the single-row
-- `multi_orchestrator_settings.fallback_agent_id` becomes the instance entry
-- (a database that had none starts with the instance entry `off`) and the
-- table goes, with its facilitator trigger.
--
-- `principal` is a user principal in its wire form `user:<id>` (channel SDK
-- `formatPrincipal`, trim + lowercase). An entry keeps pointing to a deleted
-- agent (tombstone): the message there gets "<name> was deleted" until the
-- operator changes the entry, so ON DELETE RESTRICT keeps a purge from
-- silently removing it.
--
-- Idempotent (the CI schema job applies everything twice).

CREATE TABLE IF NOT EXISTS agent_default_entries (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  principal    TEXT,
  channel_type TEXT,
  agent_id     UUID REFERENCES agents(id) ON DELETE RESTRICT,
  updated_by   TEXT,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT agent_default_entries_principal_form
    CHECK (principal IS NULL OR principal ~ '^user:.+'),
  CONSTRAINT agent_default_entries_channel_form
    CHECK (channel_type IS NULL OR length(btrim(channel_type)) > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS agent_default_entries_scope_uq
  ON agent_default_entries (COALESCE(principal, ''), COALESCE(channel_type, ''));
CREATE INDEX IF NOT EXISTS agent_default_entries_agent_idx
  ON agent_default_entries (agent_id) WHERE agent_id IS NOT NULL;

COMMENT ON TABLE agent_default_entries IS
  '#2055 default agents: (principal, channel) > (principal) > (channel) > instance; agent_id NULL = off.';

-- A facilitator has no default-agent role (spec 2043): it is reached through
-- its own identity or not at all.
CREATE OR REPLACE FUNCTION agent_default_entries_refuse_facilitator() RETURNS trigger AS $$
BEGIN
  IF NEW.agent_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM agents WHERE id = NEW.agent_id AND archetype = 'facilitator'
  ) THEN
    RAISE EXCEPTION 'a facilitator cannot be a default agent (agent id %)', NEW.agent_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'default_agent_not_facilitator';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS agent_default_entries_not_facilitator ON agent_default_entries;
CREATE TRIGGER agent_default_entries_not_facilitator
  BEFORE INSERT OR UPDATE OF agent_id ON agent_default_entries
  FOR EACH ROW EXECUTE FUNCTION agent_default_entries_refuse_facilitator();

-- Routing reloads on every change (the payload `platform` = full reload).
DROP TRIGGER IF EXISTS agent_default_entries_notify ON agent_default_entries;
CREATE TRIGGER agent_default_entries_notify
  AFTER INSERT OR UPDATE OR DELETE ON agent_default_entries
  FOR EACH ROW EXECUTE FUNCTION notify_agents_changed();

-- The former fallback agent becomes the instance entry; without one the
-- instance entry is `off`.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = 'multi_orchestrator_settings' AND column_name = 'fallback_agent_id'
  ) THEN
    INSERT INTO agent_default_entries (principal, channel_type, agent_id, updated_by)
    SELECT NULL, NULL, s.fallback_agent_id, 'migration:0081'
      FROM multi_orchestrator_settings s
     WHERE s.id
    ON CONFLICT DO NOTHING;
  END IF;
  INSERT INTO agent_default_entries (principal, channel_type, agent_id, updated_by)
  VALUES (NULL, NULL, NULL, 'migration:0081')
  ON CONFLICT DO NOTHING;
END $$;

-- A tombstone stays referenced by entries, so the delete guard of 0072 no
-- longer needs to know a default agent: it only refuses a restore.
CREATE OR REPLACE FUNCTION agents_guard_tombstone() RETURNS trigger AS $$
BEGIN
  IF OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL THEN
    RAISE EXCEPTION 'agent % was deleted and cannot be restored; create a new agent', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'agents_tombstone_final';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS fallback_agent_not_facilitator ON multi_orchestrator_settings;
DROP FUNCTION IF EXISTS settings_refuse_facilitator_fallback();
DROP TABLE IF EXISTS multi_orchestrator_settings;

-- rollback:
--   CREATE TABLE multi_orchestrator_settings (id BOOLEAN PRIMARY KEY DEFAULT true CHECK (id),
--     fallback_agent_id UUID REFERENCES agents(id) ON DELETE SET NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
--   INSERT INTO multi_orchestrator_settings (id, fallback_agent_id)
--     SELECT true, agent_id FROM agent_default_entries WHERE principal IS NULL AND channel_type IS NULL;
--   (restore settings_refuse_facilitator_fallback + trigger from 0070, agents_guard_tombstone from 0072)
--   DROP TABLE agent_default_entries;
--   DROP FUNCTION agent_default_entries_refuse_facilitator();
