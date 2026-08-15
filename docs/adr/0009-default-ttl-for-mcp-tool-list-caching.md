# Default TTL for MCP tool-list caching when servers omit ttlMs

MCP 2026-07-28 says a `tools/list` result without `ttlMs` must be treated as `ttlMs: 0` — i.e. not cached. Almost all remote servers we connect to today speak protocol ≤ 2025-11-25 and emit no `ttlMs`, so a spec-strict client cache would be a no-op and the cost/latency win of #545 (fewer discovery round-trips, stable prompt-cache tool blocks) would not materialize. We deliberately deviate on the client side: `McpManager` applies a configurable default TTL (60s, `OMADIA_MCP_TOOLLIST_TTL_MS`, opt-out via `0`) to list results that carry no `ttlMs`, and clamps server-provided TTLs to 15 minutes.

The spec binds servers' emission, not clients' caching policy, so this is a policy choice, not a protocol violation. Safety valves: Discovery and Rescan always bypass the cache, `notifications/tools/list_changed` purges it immediately, entries are keyed like the connection pool (token-hash for `private`/unknown scope, server id for `public`), and tool *calls* are never gated on a cached list.

Considered and rejected: spec-strict no-cache-without-ttlMs (defeats the purpose of the issue until the external ecosystem catches up to 2026-07-28).

One correction to "until the ecosystem catches up": for `stdio` and `sse` peers it never will. #562 measured that `server/discover` is answered at the HTTP edge only — a non-HTTP peer returns `-32601` regardless of its advertised versions, and pinning fails with `ERA_NEGOTIATION_FAILED` — so those transports stay legacy-era by construction and can never carry `ttlMs`. The default TTL is therefore the permanent path for them, not a transitional one. `http` peers are the only ones from which a server-declared TTL can arrive, and it does: verified end to end that `ttlMs`/`cacheScope` reach the client verbatim even though `listTools` runs with the SDK's `cacheMode: 'bypass'` (that bypass skips the SDK's own response cache, not the hints).

See also ADR-0008 (MCP connection lifetime) for the pool this cache is keyed against.
