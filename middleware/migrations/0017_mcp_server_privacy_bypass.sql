-- Epic #459 — per-MCP-server Privacy Shield bypass.
--
-- When an operator marks a server as privacy_bypass, its tool results are
-- passed through UNMASKED (and recorded on the privacy receipt as a bypassed
-- tool for transparency). Off by default; the org override
-- OMADIA_PRIVACY_FORCE_GUARDED=true still clamps everything back to guarded.
ALTER TABLE mcp_servers
  ADD COLUMN IF NOT EXISTS privacy_bypass BOOLEAN NOT NULL DEFAULT false;
