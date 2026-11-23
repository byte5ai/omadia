-- Remember the RFC 8707 `resource` indicator of an MCP OAuth authorization
-- request on the pending flow. The MCP authorization spec requires the same
-- `resource` on the token request as on the authorization request; the
-- callback had no value to send because only the authorize URL carried it.
-- NULL on flows started before this migration: their code exchange sends no
-- `resource`, exactly as before.
ALTER TABLE mcp_oauth_flows
  ADD COLUMN IF NOT EXISTS resource TEXT;

-- rollback: ALTER TABLE mcp_oauth_flows DROP COLUMN resource;
