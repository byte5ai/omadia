-- ── MCP call audit log (epic #459 W2, issue #462) ───────────────────────────
-- Append-only audit trail for every McpManager.callTool invocation — the one
-- choke point all MCP traffic flows through (sub-agent tools, top-level
-- DomainTools from #457, the plugin accessor from #458 later). Deliberately
-- stores NO tool arguments: server, tool, caller identity, outcome, duration,
-- timestamp only. server_id is nullable with the name denormalized so audit
-- rows survive server deletion.
CREATE TABLE IF NOT EXISTS mcp_call_log (
  id           BIGSERIAL PRIMARY KEY,
  server_id    UUID REFERENCES mcp_servers(id) ON DELETE SET NULL,
  server_name  TEXT NOT NULL,
  tool_name    TEXT NOT NULL,
  caller_kind  TEXT NOT NULL
               CHECK (caller_kind IN ('agent', 'subagent', 'skill', 'plugin', 'unattributed')),
  caller_agent TEXT,
  turn_id      TEXT,
  ok           BOOLEAN NOT NULL,
  error        TEXT,
  duration_ms  INTEGER NOT NULL,
  called_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mcp_call_log_called_at_idx
  ON mcp_call_log (called_at DESC);
CREATE INDEX IF NOT EXISTS mcp_call_log_server_idx
  ON mcp_call_log (server_id, called_at DESC);

-- rollback: DROP TABLE mcp_call_log;
