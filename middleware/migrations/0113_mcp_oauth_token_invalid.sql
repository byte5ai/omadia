-- Record on the token row that a stored MCP OAuth authorization stopped
-- working (#1923). A row used to mean "authorized" for as long as it existed,
-- so the MCP Control Center kept saying so after the authorization server
-- refused the refresh or the MCP server answered 401 to the token.
--
-- invalid_reason:
--   refresh_failed  the token endpoint answered the refresh and refused it
--   rejected        the MCP server refused a call that carried the token
-- NULL means nothing is known to be wrong. Storing a new token (a login or a
-- successful refresh) sets both columns back to NULL. An access token that
-- has expired and has no refresh token is read from expires_at and
-- refresh_token_ref, it needs no mark here.
ALTER TABLE mcp_oauth_tokens
  ADD COLUMN IF NOT EXISTS invalid_reason TEXT
    CHECK (invalid_reason IN ('refresh_failed', 'rejected')),
  ADD COLUMN IF NOT EXISTS invalid_at TIMESTAMPTZ;

-- rollback: ALTER TABLE mcp_oauth_tokens DROP COLUMN invalid_reason, DROP COLUMN invalid_at;
