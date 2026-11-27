-- #2312 / ADR-0301 — how an MCP OAuth flow is completed. `session`: the
-- omadia session that started it finishes it at the callback (ADR-0175).
-- `teams-sso`: a directory person started it with their Teams SSO token; the
-- callback only hands the code back to Teams, and the completion needs the
-- same person's SSO token. A flow can never be finished the other way.
ALTER TABLE mcp_oauth_flows
  ADD COLUMN IF NOT EXISTS completion text NOT NULL DEFAULT 'session'
    CHECK (completion IN ('session', 'teams-sso'));

-- The authorize URL of a `teams-sso` flow. Teams' authentication window must
-- start on the deployment's own host, so it opens
-- `/api/v1/directory/connect/go/<state>`, which redirects here. Session flows
-- keep NULL (the browser goes to the provider directly).
ALTER TABLE mcp_oauth_flows ADD COLUMN IF NOT EXISTS authorize_url text;

-- rollback: ALTER TABLE mcp_oauth_flows DROP COLUMN authorize_url, DROP COLUMN completion;
