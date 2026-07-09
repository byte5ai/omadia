/**
 * Epic #459 — LIVE per-MCP-server Knowledge-Graph ingestion set.
 *
 * Mirrors mcpPrivacyBypass: the ingestion decision is read at dispatch time by
 * server id (a `registry.reload()` is additive and won't update a baked flag),
 * refreshed by the middleware whenever an MCP server changes.
 */

let ingestServerIds: ReadonlySet<string> = new Set();

/** Replace the set of MCP server ids whose successful tool results are written
 *  to the Knowledge Graph. Called by the middleware on boot + on each change. */
export function setMcpKgIngestServers(ids: Iterable<string>): void {
  ingestServerIds = new Set(ids);
}

/** True when this MCP server is currently operator-flagged for KG ingestion. */
export function isMcpServerKgIngest(serverId: string | undefined): boolean {
  return serverId !== undefined && ingestServerIds.has(serverId);
}
