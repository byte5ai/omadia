-- 0114 — the outcome of the last security re-scan per MCP server (#1916).
--
-- `POST /api/v1/operator/mcp-servers/rescan-all` and the periodic re-scan
-- (`MCP_RESCAN_INTERVAL_MS`) used to report a server that failed to scan only
-- in their return value and the log, so the MCP Control Center showed nothing.
-- Both now stamp the row: `last_scan_at` on every attempt, `last_scan_error`
-- with a bounded message on failure (NULL after a successful scan).

ALTER TABLE mcp_servers
  ADD COLUMN IF NOT EXISTS last_scan_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_scan_error TEXT;

-- rollback: ALTER TABLE mcp_servers DROP COLUMN last_scan_at, DROP COLUMN last_scan_error;
