-- 0001_multi_orchestrator.sql
--
-- Schema for the multi-orchestrator runtime (US4). Establishes the four
-- config tables (agents, agent_plugins, channel_bindings, multi_orchestrator_settings)
-- plus the notify_agents_changed trigger that drives the LISTEN/NOTIFY
-- hot-reload bus introduced in US5.
--
-- See specs/001-multi-orchestrator-runtime/data-model.md for the full
-- rationale behind each table. Idempotent (IF NOT EXISTS / CREATE OR REPLACE)
-- so a re-application is a no-op.

CREATE TABLE IF NOT EXISTS agents (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug            TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  description     TEXT,
  privacy_profile TEXT NOT NULL DEFAULT 'default'
                    CHECK (privacy_profile IN ('strict', 'default')),
  status          TEXT NOT NULL DEFAULT 'enabled'
                    CHECK (status IN ('enabled', 'disabled')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agent_plugins (
  agent_id    UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  plugin_id   TEXT NOT NULL,
  config      JSONB NOT NULL DEFAULT '{}',
  enabled     BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, plugin_id)
);

CREATE TABLE IF NOT EXISTS channel_bindings (
  channel_type TEXT NOT NULL,
  channel_key  TEXT NOT NULL,
  agent_id     UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (channel_type, channel_key)
);
CREATE INDEX IF NOT EXISTS channel_bindings_agent_idx
  ON channel_bindings(agent_id);

CREATE TABLE IF NOT EXISTS multi_orchestrator_settings (
  id                BOOLEAN PRIMARY KEY DEFAULT true CHECK (id),
  fallback_agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Single-row guard: the row is created lazily by the registry, but seed
-- one here so first-boot reads never see an empty result.
INSERT INTO multi_orchestrator_settings (id) VALUES (true)
ON CONFLICT (id) DO NOTHING;

-- Change-notification trigger. Payload is the agent_id as text (or the
-- literal 'platform' for the single-row multi_orchestrator_settings table) so a
-- registry on every Fly machine can compute a minimal diff in US5.
CREATE OR REPLACE FUNCTION notify_agents_changed() RETURNS trigger AS $$
DECLARE
  payload TEXT;
BEGIN
  IF TG_TABLE_NAME = 'multi_orchestrator_settings' THEN
    payload := 'platform';
  ELSIF TG_OP = 'DELETE' THEN
    payload := COALESCE(OLD.agent_id::text, OLD.id::text);
  ELSE
    payload := COALESCE(NEW.agent_id::text, NEW.id::text);
  END IF;
  PERFORM pg_notify('agents_changed', payload);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS agents_notify ON agents;
CREATE TRIGGER agents_notify
  AFTER INSERT OR UPDATE OR DELETE ON agents
  FOR EACH ROW EXECUTE FUNCTION notify_agents_changed();

DROP TRIGGER IF EXISTS agent_plugins_notify ON agent_plugins;
CREATE TRIGGER agent_plugins_notify
  AFTER INSERT OR UPDATE OR DELETE ON agent_plugins
  FOR EACH ROW EXECUTE FUNCTION notify_agents_changed();

DROP TRIGGER IF EXISTS channel_bindings_notify ON channel_bindings;
CREATE TRIGGER channel_bindings_notify
  AFTER INSERT OR UPDATE OR DELETE ON channel_bindings
  FOR EACH ROW EXECUTE FUNCTION notify_agents_changed();

DROP TRIGGER IF EXISTS multi_orchestrator_settings_notify ON multi_orchestrator_settings;
CREATE TRIGGER multi_orchestrator_settings_notify
  AFTER INSERT OR UPDATE OR DELETE ON multi_orchestrator_settings
  FOR EACH ROW EXECUTE FUNCTION notify_agents_changed();
