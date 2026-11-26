-- #1951: attribute the successful grant to the signed-in initiator even
-- when the OAuth callback has no operator cookie.
ALTER TABLE mcp_oauth_flows
  ADD COLUMN IF NOT EXISTS audit_actor_id uuid,
  ADD COLUMN IF NOT EXISTS audit_actor_email text;

-- rollback: ALTER TABLE mcp_oauth_flows DROP COLUMN audit_actor_id, DROP COLUMN audit_actor_email;
