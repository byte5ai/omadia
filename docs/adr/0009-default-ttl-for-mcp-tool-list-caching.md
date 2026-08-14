# Default TTL for MCP tool-list caching when servers omit ttlMs

MCP 2026-07-28 says a `tools/list` result without `ttlMs` must be treated as `ttlMs: 0` — i.e. not cached. Almost all remote servers we connect to today speak protocol ≤ 2025-11-25 and emit no `ttlMs`, so a spec-strict client cache would be a no-op and the cost/latency win of #545 (fewer discovery round-trips, stable prompt-cache tool blocks) would not materialize. We deliberately deviate on the client side: `McpManager` applies a configurable default TTL (60s, `OMADIA_MCP_TOOLLIST_TTL_MS`, opt-out via `0`) to list results that carry no `ttlMs`, and clamps server-provided TTLs to 15 minutes.

The spec binds servers' emission, not clients' caching policy, so this is a policy choice, not a protocol violation. Safety valves: Discovery and Rescan always bypass the cache, `notifications/tools/list_changed` purges it immediately, entries are keyed like the connection pool (token-hash for `private`/unknown scope, server id for `public`), and tool *calls* are never gated on a cached list.

Considered and rejected: spec-strict no-cache-without-ttlMs (defeats the purpose of the issue until the external ecosystem catches up to 2026-07-28).

See also ADR-0008 (MCP connection lifetime) for the pool this cache is keyed against.
