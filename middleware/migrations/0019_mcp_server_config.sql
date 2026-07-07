-- Epic #459 — schema-driven MCP server config.
--
-- config_schema: declared config fields for this server
--   [{ key, label, type, required, secret }]. Derived from endpoint/header
--   placeholders or a registry entry.
-- config: NON-SECRET config values { key: value }. Secret values NEVER live here
--   — they are stored in the Vault (namespace @omadia/mcp-config) and resolved
--   at connect time. `{key}` placeholders in endpoint/headers are substituted
--   from these values (non-secret) or the Vault (secret).
ALTER TABLE mcp_servers
  ADD COLUMN IF NOT EXISTS config_schema JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS config JSONB NOT NULL DEFAULT '{}'::jsonb;
