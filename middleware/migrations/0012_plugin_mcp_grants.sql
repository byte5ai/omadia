-- ── Plugin → MCP server grants (epic #459 W5, issue #458) ───────────────────
-- The operator explicitly grants a plugin access to individual MCP servers;
-- ctx.mcp resolves only granted servers (deny-by-default, never ambient).
-- Grant unit is the SERVER (the accessor is server-scoped); per-tool safety
-- comes from the dispatch guard, which applies to plugin calls unchanged.
-- plugin_id is the manifest identity string — plugins have no agents-table
-- row, which is why this is a sibling table rather than a third scope on
-- agent_tool_grants (decision recorded on #458).
CREATE TABLE IF NOT EXISTS plugin_mcp_grants (
  plugin_id     TEXT NOT NULL,
  mcp_server_id UUID NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
  granted_by    TEXT NOT NULL,
  granted_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (plugin_id, mcp_server_id)
);

-- rollback: DROP TABLE plugin_mcp_grants;
