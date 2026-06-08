-- 0003_agent_builder_graph.sql
--
-- Agent Builder canvas (P0). Adds the editable graph primitives that the
-- visual builder wires together: skills, MCP servers, sub-agents, tool grants
-- and schedule triggers — plus per-agent model-routing config and cosmetic
-- canvas coordinates.
--
-- Source of truth is Postgres (copy-on-write from file-defined plugin
-- defaults): the first canvas edit forks an agent's wiring into these tables
-- and the DB rows become authoritative from then on.
--
-- Every mutation re-uses the existing notify_agents_changed bus so the
-- OrchestratorRegistry hot-reloads without a restart (the payload is only a
-- wake-up signal — the registry always recomputes a full snapshot diff).
--
-- Idempotent (IF NOT EXISTS / CREATE OR REPLACE) so re-application is a no-op.

-- ── skills ────────────────────────────────────────────────────────────────
-- DB-backed playbooks. `source='file'` rows are read-only mirrors imported
-- from SKILL.md; `source='db'` rows are operator-authored / forked.
CREATE TABLE IF NOT EXISTS skills (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  description TEXT,
  body        TEXT NOT NULL DEFAULT '',
  frontmatter JSONB NOT NULL DEFAULT '{}',
  source      TEXT NOT NULL DEFAULT 'db' CHECK (source IN ('db', 'file')),
  source_path TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── mcp_servers ─────────────────────────────────────────────────────────────
-- External MCP endpoints registered for tool discovery. Secrets are never
-- stored raw — `secret_ref` keys into the existing secrets store; `headers`
-- holds only non-sensitive metadata.
CREATE TABLE IF NOT EXISTS mcp_servers (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name               TEXT NOT NULL UNIQUE,
  transport          TEXT NOT NULL CHECK (transport IN ('stdio', 'http', 'sse')),
  endpoint           TEXT,
  headers            JSONB NOT NULL DEFAULT '{}',
  secret_ref         TEXT,
  status             TEXT NOT NULL DEFAULT 'enabled'
                       CHECK (status IN ('enabled', 'disabled')),
  last_discovered_at TIMESTAMPTZ,
  discovered_tools   JSONB NOT NULL DEFAULT '[]',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── agent_subagents ───────────────────────────────────────────────────────
-- A capability-scoped in-process LocalSubAgent owned by a parent agent.
CREATE TABLE IF NOT EXISTS agent_subagents (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_agent_id        UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  name                   TEXT NOT NULL,
  skill_id               UUID REFERENCES skills(id) ON DELETE SET NULL,
  model                  TEXT,          -- null = inherit parent
  max_tokens             INT,
  max_iterations         INT,
  system_prompt_override TEXT,          -- null = use skill body
  status                 TEXT NOT NULL DEFAULT 'enabled'
                           CHECK (status IN ('enabled', 'disabled')),
  position               JSONB,         -- canvas {x,y}
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (parent_agent_id, name)
);
CREATE INDEX IF NOT EXISTS agent_subagents_parent_idx
  ON agent_subagents(parent_agent_id);
CREATE INDEX IF NOT EXISTS agent_subagents_skill_idx
  ON agent_subagents(skill_id);

-- ── agent_tool_grants ───────────────────────────────────────────────────────
-- Which native / MCP tool an agent (or one of its sub-agents) may use.
-- Exactly one of agent_id / subagent_id is set.
CREATE TABLE IF NOT EXISTS agent_tool_grants (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id      UUID REFERENCES agents(id) ON DELETE CASCADE,
  subagent_id   UUID REFERENCES agent_subagents(id) ON DELETE CASCADE,
  tool_kind     TEXT NOT NULL CHECK (tool_kind IN ('native', 'mcp')),
  tool_ref      TEXT NOT NULL,         -- native name, or "<server>:<tool>"
  mcp_server_id UUID REFERENCES mcp_servers(id) ON DELETE CASCADE,
  config        JSONB NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (agent_id IS NOT NULL OR subagent_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS agent_tool_grants_agent_idx
  ON agent_tool_grants(agent_id);
CREATE INDEX IF NOT EXISTS agent_tool_grants_subagent_idx
  ON agent_tool_grants(subagent_id);

-- ── agent_schedules ─────────────────────────────────────────────────────────
-- Cron trigger → synthetic agent turn.
CREATE TABLE IF NOT EXISTS agent_schedules (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id    UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  cron        TEXT NOT NULL,
  payload     JSONB NOT NULL DEFAULT '{}',
  timezone    TEXT NOT NULL DEFAULT 'UTC',
  status      TEXT NOT NULL DEFAULT 'enabled'
                CHECK (status IN ('enabled', 'disabled')),
  last_run_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_schedules_agent_idx
  ON agent_schedules(agent_id);

-- ── agents / channel_bindings extensions ────────────────────────────────────
-- model_routing: { mode:'single'|'triage', main, triage?, escalate_on?[] }
ALTER TABLE agents ADD COLUMN IF NOT EXISTS model_routing JSONB;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS canvas_position JSONB;
ALTER TABLE channel_bindings ADD COLUMN IF NOT EXISTS canvas_position JSONB;

-- ── notify trigger: teach it the new row shapes ──────────────────────────────
-- The payload is only a wake-up hint; correctness comes from the registry's
-- full snapshot diff. Branch by TG_TABLE_NAME so each row touches only the
-- columns it actually has (plpgsql binds field refs at execution time).
CREATE OR REPLACE FUNCTION notify_agents_changed() RETURNS trigger AS $$
DECLARE
  payload TEXT;
BEGIN
  IF TG_TABLE_NAME = 'multi_orchestrator_settings' THEN
    payload := 'platform';
  ELSIF TG_TABLE_NAME = 'agents' THEN
    payload := COALESCE((CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END)::text, 'platform');
  ELSIF TG_TABLE_NAME IN ('agent_plugins', 'channel_bindings', 'agent_schedules') THEN
    payload := COALESCE((CASE WHEN TG_OP = 'DELETE' THEN OLD.agent_id ELSE NEW.agent_id END)::text, 'platform');
  ELSIF TG_TABLE_NAME = 'agent_subagents' THEN
    payload := COALESCE((CASE WHEN TG_OP = 'DELETE' THEN OLD.parent_agent_id ELSE NEW.parent_agent_id END)::text, 'platform');
  ELSE
    -- skills, mcp_servers, agent_tool_grants — fan-out potential, full reload.
    payload := 'platform';
  END IF;
  PERFORM pg_notify('agents_changed', payload);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS skills_notify ON skills;
CREATE TRIGGER skills_notify
  AFTER INSERT OR UPDATE OR DELETE ON skills
  FOR EACH ROW EXECUTE FUNCTION notify_agents_changed();

DROP TRIGGER IF EXISTS mcp_servers_notify ON mcp_servers;
CREATE TRIGGER mcp_servers_notify
  AFTER INSERT OR UPDATE OR DELETE ON mcp_servers
  FOR EACH ROW EXECUTE FUNCTION notify_agents_changed();

DROP TRIGGER IF EXISTS agent_subagents_notify ON agent_subagents;
CREATE TRIGGER agent_subagents_notify
  AFTER INSERT OR UPDATE OR DELETE ON agent_subagents
  FOR EACH ROW EXECUTE FUNCTION notify_agents_changed();

DROP TRIGGER IF EXISTS agent_tool_grants_notify ON agent_tool_grants;
CREATE TRIGGER agent_tool_grants_notify
  AFTER INSERT OR UPDATE OR DELETE ON agent_tool_grants
  FOR EACH ROW EXECUTE FUNCTION notify_agents_changed();

DROP TRIGGER IF EXISTS agent_schedules_notify ON agent_schedules;
CREATE TRIGGER agent_schedules_notify
  AFTER INSERT OR UPDATE OR DELETE ON agent_schedules
  FOR EACH ROW EXECUTE FUNCTION notify_agents_changed();
