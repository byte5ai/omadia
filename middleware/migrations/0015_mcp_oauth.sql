-- ── Generic MCP authorization / OAuth 2.1 (epic #459 W9, issue #455) ────────
-- Provider-agnostic support for the MCP Authorization spec: a server advertises
-- its auth server via RFC 9728 protected-resource metadata; the client uses
-- RFC 8414 auth-server metadata + (RFC 7591) dynamic client registration or a
-- one-time operator-provided client, then OAuth 2.1 + PKCE. Nothing here is
-- specific to any provider — Strava is just the first server that implements
-- the spec.

-- One OAuth client per authorization-server ISSUER (not per MCP server): a DCR
-- self-registration, or an operator-entered client_id/secret for issuers that
-- do not support DCR (e.g. Strava). Reused across every MCP server that
-- delegates to the same issuer.
CREATE TABLE IF NOT EXISTS mcp_oauth_clients (
  issuer            TEXT PRIMARY KEY,
  client_id         TEXT NOT NULL,
  -- Secret lives in the vault; this is the reference key, null for public
  -- (PKCE-only) clients.
  client_secret_ref TEXT,
  registered_via    TEXT NOT NULL CHECK (registered_via IN ('dcr', 'manual')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Per-user access/refresh tokens for one MCP server. user_key identifies the
-- caller the token belongs to (operator identity in the operator chat; an
-- end-user id later). Token values live in the vault; rows hold refs + expiry.
CREATE TABLE IF NOT EXISTS mcp_oauth_tokens (
  server_id         UUID NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
  user_key          TEXT NOT NULL,
  access_token_ref  TEXT NOT NULL,
  refresh_token_ref TEXT,
  expires_at        TIMESTAMPTZ,
  scopes            TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (server_id, user_key)
);

-- Short-lived pending authorization flows: the PKCE code_verifier + CSRF state
-- created when we build an authorize URL, consumed at the callback. Rows are
-- one-shot and pruned by age.
CREATE TABLE IF NOT EXISTS mcp_oauth_flows (
  state         TEXT PRIMARY KEY,
  server_id     UUID NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
  user_key      TEXT NOT NULL,
  issuer        TEXT NOT NULL,
  code_verifier TEXT NOT NULL,
  redirect_uri  TEXT NOT NULL,
  scopes        TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mcp_oauth_flows_created_idx ON mcp_oauth_flows (created_at);

-- rollback: DROP TABLE mcp_oauth_flows; DROP TABLE mcp_oauth_tokens; DROP TABLE mcp_oauth_clients;
