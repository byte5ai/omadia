-- ── MCP marketplace connectivity (epic #459 W3, issue #455) ─────────────────
-- Registry catalog sources, mirroring the plugin RegistryConfigEntry pattern
-- (multi-registry, optional bearer token). Seeded with the official MCP
-- registry; operators add Smithery/Glama/private registries the same way.
CREATE TABLE IF NOT EXISTS mcp_registries (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL UNIQUE,
  url        TEXT NOT NULL,
  auth_kind  TEXT NOT NULL DEFAULT 'none' CHECK (auth_kind IN ('none', 'bearer')),
  token      TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO mcp_registries (name, url, auth_kind)
VALUES ('official', 'https://registry.modelcontextprotocol.io', 'none')
ON CONFLICT (name) DO NOTHING;

-- Provenance columns on mcp_servers: everything so far was implicitly
-- first-party/manual. Marketplace-sourced servers carry where they came from
-- and their license (the #435 licensing finding: unlicensed hobby servers are
-- the common risk, so license visibility is non-optional in the UI).
ALTER TABLE mcp_servers
  ADD COLUMN IF NOT EXISTS source     TEXT NOT NULL DEFAULT 'manual'
    CHECK (source IN ('manual', 'marketplace')),
  ADD COLUMN IF NOT EXISTS registry_id UUID REFERENCES mcp_registries(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS license    TEXT,
  ADD COLUMN IF NOT EXISTS author     TEXT,
  ADD COLUMN IF NOT EXISTS source_url TEXT;

-- rollback: ALTER TABLE mcp_servers DROP COLUMN source, DROP COLUMN registry_id,
--   DROP COLUMN license, DROP COLUMN author, DROP COLUMN source_url;
--   DROP TABLE mcp_registries;
