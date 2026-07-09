-- ── Skill → MCP capability bindings (epic #459 W4, issue #456) ──────────────
-- A skill declares `requires_tools: [{ contract, description }]` in its
-- frontmatter (reference, never an embedded endpoint). The OPERATOR binds each
-- contract to one of their trusted servers' tools; the binding is the point
-- where trust is applied. Created only through the bind route (verdict-gated),
-- never automatically. Unbound contracts fail closed at hydration.
CREATE TABLE IF NOT EXISTS skill_tool_bindings (
  skill_id      UUID NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  contract      TEXT NOT NULL,
  mcp_server_id UUID NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
  tool_name     TEXT NOT NULL,
  bound_by      TEXT NOT NULL,
  bound_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (skill_id, contract)
);
CREATE INDEX IF NOT EXISTS skill_tool_bindings_server_idx
  ON skill_tool_bindings(mcp_server_id);

-- rollback: DROP TABLE skill_tool_bindings;
