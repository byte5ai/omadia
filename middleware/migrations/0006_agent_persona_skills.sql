-- ── agent persona skills (Wave 8) ────────────────────────────────────────────
-- An Agent (Orchestrator) can attach zero or more skills as candidate
-- "direct-answer" personas — skills that shape the TOP-LEVEL orchestrator's
-- own system prompt for a turn, with no sub-agent/tool-call indirection.
-- Distinct from agent_subagents.skill_id (Wave 0/2), which backs a delegated
-- specialist, not the primary chat identity. Pure join table: cascades both
-- ways, no per-link config beyond display ordering.
CREATE TABLE IF NOT EXISTS agent_persona_skills (
  agent_id   UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  skill_id   UUID NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  position   INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, skill_id)
);
CREATE INDEX IF NOT EXISTS agent_persona_skills_agent_idx ON agent_persona_skills(agent_id);
CREATE INDEX IF NOT EXISTS agent_persona_skills_skill_idx ON agent_persona_skills(skill_id);
