-- ── MCP registry kinds + Smithery seed (epic #459 W7, issue #455) ───────────
-- Different registries speak different catalog APIs. `kind` selects the client
-- normalizer: 'official' (registry.modelcontextprotocol.io — remotes[] carry
-- endpoints directly), 'smithery' (largest catalog, 6777+ servers; list has no
-- endpoint, so it is resolved per-server at connect time), 'generic' (a plain
-- { servers:[...] } document or the official shape).
ALTER TABLE mcp_registries
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'generic'
    CHECK (kind IN ('official', 'smithery', 'generic'));

UPDATE mcp_registries
  SET kind = 'official'
  WHERE url = 'https://registry.modelcontextprotocol.io' AND kind = 'generic';

-- Pre-configure Smithery — the largest MCP marketplace with a usable API, and
-- keyless to browse — so every install can discover servers from the first run.
-- Note: browsing is keyless; connecting to some Smithery-hosted servers needs
-- the operator's own Smithery API key on the imported server.
INSERT INTO mcp_registries (name, url, auth_kind, kind)
VALUES ('smithery', 'https://registry.smithery.ai', 'none', 'smithery')
ON CONFLICT (name) DO NOTHING;

-- rollback: DELETE FROM mcp_registries WHERE name = 'smithery';
--           ALTER TABLE mcp_registries DROP COLUMN kind;
