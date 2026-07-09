-- ── Idempotent top-level MCP grants (epic #459 W8, codex fold) ──────────────
-- The Control Center PUT /mcp-grants is read-before-insert, so two concurrent
-- identical grants could both insert. A partial unique index makes a duplicate
-- top-level MCP grant impossible at the DB level; the route inserts with
-- ON CONFLICT DO NOTHING so a repeat is a clean no-op. Scoped to top-level
-- agent grants (agent_id set) with tool_kind='mcp' so sub-agent/native grants
-- are unaffected. Existing duplicate rows, if any, must be de-duped first.
CREATE UNIQUE INDEX IF NOT EXISTS agent_tool_grants_mcp_topLevel_uidx
  ON agent_tool_grants (agent_id, mcp_server_id, tool_ref)
  WHERE agent_id IS NOT NULL AND tool_kind = 'mcp';

-- rollback: DROP INDEX agent_tool_grants_mcp_topLevel_uidx;
