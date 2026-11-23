-- ── Availability: who may use an agent, in which channels (spec 2042 §5.3) ──
-- The management layer checks it before every turn, also for explicit
-- addressing, selections, bindings and default-agent entries. Outside it the
-- sender gets a `system` notice naming the agent, never another agent.
--
--   agents.available_to_everyone  everyone in the tenant may use the agent
--   agents.available_channels     channel types it serves; NULL = all
--   agent_availability_principals named people (`user:<id>`) and groups
--                                 (`role:<key>`, Conductor roles)
--
-- A fresh agent is available to nobody until the operator sets it (default
-- false). Agents that exist when this migration runs keep serving as before:
-- everyone, every channel.
--
-- Idempotent (the CI schema job applies everything twice): the backfill runs
-- only in the run that adds the column.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = 'agents' AND column_name = 'available_to_everyone'
  ) THEN
    ALTER TABLE agents ADD COLUMN available_to_everyone BOOLEAN NOT NULL DEFAULT false;
    UPDATE agents SET available_to_everyone = true WHERE deleted_at IS NULL;
  END IF;
END $$;

ALTER TABLE agents ADD COLUMN IF NOT EXISTS available_channels TEXT[];

COMMENT ON COLUMN agents.available_to_everyone IS
  'spec 2042 §5.3: everyone in the tenant may use the agent. Default false: a fresh agent is available to nobody.';
COMMENT ON COLUMN agents.available_channels IS
  'spec 2042 §5.3: channel types the agent serves; NULL = all channels.';

CREATE TABLE IF NOT EXISTS agent_availability_principals (
  agent_id   UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  principal  TEXT NOT NULL CHECK (principal ~ '^(user|role):.+'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, principal)
);

DROP TRIGGER IF EXISTS agent_availability_principals_notify ON agent_availability_principals;
CREATE TRIGGER agent_availability_principals_notify
  AFTER INSERT OR UPDATE OR DELETE ON agent_availability_principals
  FOR EACH ROW EXECUTE FUNCTION notify_agents_changed();

-- rollback:
--   DROP TABLE agent_availability_principals;
--   ALTER TABLE agents DROP COLUMN available_channels, DROP COLUMN available_to_everyone;
