-- ── MCP tool verdict cache + acknowledgements (epic #459, wave W1 / issue #454) ──
-- Mirrors the skill_verdicts pattern (0007) for MCP tool discovery: every tool a
-- remote MCP server declares is scanned before it is persisted as grantable.
-- Verdicts key on (server, tool, verifier_version) and carry the content hash of
-- the scanned name+description+inputSchema, so a re-discover with changed content
-- overwrites the verdict, while a verifier upgrade starts a fresh row instead of
-- silently reusing an old scan.
CREATE TABLE IF NOT EXISTS mcp_tool_verdicts (
  server_id        UUID NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
  tool_name        TEXT NOT NULL,
  verifier_version TEXT NOT NULL,
  content_hash     TEXT NOT NULL,
  severity         TEXT NOT NULL
                   CHECK (severity IN ('no_signals', 'flagged', 'high_risk', 'scan_failed', 'pending', 'too_large_to_scan')),
  risk_codes       JSONB NOT NULL DEFAULT '[]',
  computed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (server_id, tool_name, verifier_version)
);
CREATE INDEX IF NOT EXISTS mcp_tool_verdicts_server_idx
  ON mcp_tool_verdicts(server_id);

-- Acks record an operator's explicit decision to allow granting a high_risk
-- tool. Same mandated design as skill_verdict_acks, tightened one step further:
-- the ack stores the content_hash it was given for, and the grant gate compares
-- it against the current verdict's hash — so neither a verifier upgrade NOR a
-- content change on re-discover lets a stale ack mask new signals.
CREATE TABLE IF NOT EXISTS mcp_tool_verdict_acks (
  server_id        UUID NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
  tool_name        TEXT NOT NULL,
  verifier_version TEXT NOT NULL,
  content_hash     TEXT NOT NULL,
  acked_by         TEXT NOT NULL,
  acked_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (server_id, tool_name, verifier_version)
);

-- rollback: DROP TABLE mcp_tool_verdict_acks; DROP TABLE mcp_tool_verdicts;
