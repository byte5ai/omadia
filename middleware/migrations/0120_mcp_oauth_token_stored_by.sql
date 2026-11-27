-- #2308: who stored an MCP OAuth token. Under `service` delegation every caller
-- shares one token; the status shows whose authorization that is. Written on a
-- completed Connect from the flow's audit actor (0115), kept across refreshes.
ALTER TABLE mcp_oauth_tokens
  ADD COLUMN IF NOT EXISTS stored_by_id uuid,
  ADD COLUMN IF NOT EXISTS stored_by_email text,
  ADD COLUMN IF NOT EXISTS stored_at timestamptz;

-- rollback: ALTER TABLE mcp_oauth_tokens DROP COLUMN stored_by_id, DROP COLUMN stored_by_email, DROP COLUMN stored_at;
