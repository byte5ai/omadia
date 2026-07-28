/**
 * Epic #459 — LIVE per-MCP-server Privacy Shield bypass set.
 *
 * The bypass decision must be read at dispatch time, NOT baked into the
 * DomainTool at hydration: a `registry.reload()` is additive (it never
 * re-registers a tool whose name already exists), so a toggle would otherwise
 * only take effect after a full restart. This module holds a small mutable set
 * of bypassed server ids that the middleware refreshes whenever an MCP server
 * changes (the same `refreshMcpGrantPolicy` seam the dispatch guard uses), so
 * the orchestrator's bypass resolver always sees the current state.
 *
 * The DomainTool still carries its stable `mcpServerId` (set once, never
 * changes), which is the key into this set.
 */

let bypassedServerIds: ReadonlySet<string> = new Set();

/** Replace the set of MCP server ids whose tool results bypass Privacy Shield
 *  masking. Called by the middleware on boot and on every MCP-server change. */
export function setMcpPrivacyBypassServers(ids: Iterable<string>): void {
  bypassedServerIds = new Set(ids);
}

/** True when this MCP server is currently operator-flagged privacy-bypass. */
export function isMcpServerPrivacyBypassed(serverId: string | undefined): boolean {
  return serverId !== undefined && bypassedServerIds.has(serverId);
}
