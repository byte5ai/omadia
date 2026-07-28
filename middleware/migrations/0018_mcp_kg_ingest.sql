-- Epic #459 — opt-in MCP → Knowledge-Graph ingestion (Wave 1).
--
-- When enabled for a server, a successful tool call writes an observation into
-- the Knowledge Graph (as a per-user MemorableKnowledge node), so the returned
-- data becomes recallable. Off by default. Storage form follows the server's
-- privacy_bypass flag: masked digest when guarded, raw when bypassed.
ALTER TABLE mcp_servers
  ADD COLUMN IF NOT EXISTS kg_ingest BOOLEAN NOT NULL DEFAULT false;
