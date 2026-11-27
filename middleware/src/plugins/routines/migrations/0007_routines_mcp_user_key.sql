-- #1907 / ADR-0206 — the MCP identity a routine runs as.
--
-- A routine fires with no signed-in user, so a `per_user` MCP server had no
-- identity to act as and every routine call failed closed. The creating turn's
-- `mcpUserKey` (the authenticated session's OAuth user key, or the channel
-- identity's IdP subject) is recorded at creation and the run acts as it.
-- NULL (routines created before this migration, or from a turn without an
-- identity) keeps failing closed on `per_user` servers.

ALTER TABLE routines
  ADD COLUMN IF NOT EXISTS mcp_user_key TEXT NULL;

COMMENT ON COLUMN routines.mcp_user_key IS
  '#1907 — MCP OAuth user key of the creating turn; the run acts as it on per_user servers. NULL = no identity.';
