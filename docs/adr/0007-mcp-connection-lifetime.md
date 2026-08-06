# 0007 — MCP connection lifetime and pooling

## Status

Accepted

- **Date:** 2026-08-06
- **Deciders:** omadia maintainers
- **Supersedes:** —

## Context and Problem Statement

`McpManager` kept its connection state in two parallel maps — a pool of live
clients and a map of in-flight connects — both keyed by server id plus a hash
of the caller's bearer token. That split bookkeeping made the lifetime of an
MCP connection impossible to state in one sentence, and the gaps it hid were
real: stdio servers were spawned once **per token** even though the token never
reaches a child process, nothing ever removed an entry (a rotated OAuth token
simply left the old one, and its child process, behind for the life of the
middleware), closing a connect that was still in flight leaked the client it
later resolved to, and no route or shutdown path invalidated anything at all —
a deleted, reconfigured or disconnected server kept being served by a client
holding the old command, env, headers and token.

How long does a connection to an MCP server live, what is it keyed by, and what
ends it?

## Decision Drivers

- The installed `@modelcontextprotocol/sdk` 1.x `initialize` handshake is
  **stateful**. Any answer must be correct under that, not under the stateless
  core that #540 is waiting for.
- Credential invalidation is the highest-value behaviour in this file: a
  rejected or rotated token must never keep being used, and a revoked token's
  connection must stop serving.
- Invalidating server A must never disturb server B.
- No background timers: an unref'd reaper leaks into the server process and
  into `node --test`.
- No dependency changes.

## Considered Options

- **A — One entry map, transport-aware keys, lazy idle TTL, explicit invalidation**
- **B — Connect per call for http/sse, pool only stdio**
- **C — Spawn a stdio child per call**
- **D — A background reaper thread/timer for eviction**
- **E — Collapse the runtime and Builder `McpManager` instances into one**

## Decision Outcome

Chosen option: **A**, because it states the lifetime as one rule set over one
data structure, and every defect above falls out of it directly.

- **Key.** A pooled entry is keyed by exactly the inputs its transport actually
  consumes. `stdio` → the server id alone; `http`/`sse` → the server id plus a
  12-hex-char SHA-256 prefix of the bearer token, so two callers' authenticated
  sessions stay apart. Result: one long-lived child process per stdio server,
  never one per token.
- **One map.** A single `Map<key, { promise, lastUsedAt }>`. The promise is the
  entry's state — pending while connecting, settled afterwards — so there is no
  second map that can disagree with it. A rejected connect removes itself and is
  never cached; closing an entry that is still connecting tears the client down
  when it lands.
- **End of life.** An entry is dropped on a failed connect, on a failed tool
  call, when a stale token is rejected, on explicit invalidation, when it has
  been idle longer than `idleTtlMs` (default 5 minutes), and on `closeAll()`.
- **Explicit invalidation.** `DELETE /mcp-servers/:id`,
  `PUT /mcp-servers/:id/config` and `DELETE /mcp-servers/:id/token` drop the
  affected server's connection in the Builder router's manager and — through the
  `onMcpServerChanged` callback — in the runtime manager. `shutdownBuilder`
  calls `closeAll()` on SIGTERM/SIGINT so stdio children do not outlive us.
- **`close(id)` is server-scoped.** It drops every key matching
  `key === id || key.startsWith(id + '#')`, exported as `mcpPoolScopeMatches`
  so that rule lives in exactly one place. The `#` separator is what stops
  server `abc` from taking `abcd` down with it.
- **Eviction is lazy.** The sweep runs inside `getOrConnect`. An idle entry can
  therefore outlive its TTL until the next connect attempt for *some* server.
  That is the accepted price of having no background timer.

### Consequences

- 🟢 **Good:** N users of one stdio server share one child process instead of N.
- 🟢 **Good:** The pool is bounded — token rotation no longer leaks an entry (and
  a process) per rotation.
- 🟢 **Good:** Operator actions take effect immediately; the middleware no longer
  leaves MCP child processes behind on shutdown.
- 🔴 **Bad:** Idle eviction closes an `SSEClientTransport`'s long-lived stream.
  Nothing in this repo consumes server-initiated MCP notifications (only
  `listTools` and `callTool`), so nothing observable is lost today — but a future
  notification consumer must revisit the TTL for `sse`.
- 🔴 **Bad:** `close(id)` is widened for out-of-repo callers (private byte5 and
  Hub plugins): passing a bare server id now closes every token-scoped entry of
  that server, not one. The failure mode is an extra reconnect, never a leak.
- ⚪ **Neutral:** A stdio child now serves several callers, so a server that
  keeps per-connection state across `tools/call` would share it. That matches the
  MCP model (a server is a shared process, authorization travels per request)
  and was already true for every unauthenticated caller.

## Pros and Cons of the Options

### A — One entry map, transport-aware keys, lazy idle TTL, explicit invalidation

- 🟢 One data structure, one rule set, testable end to end against a real child
  process.
- 🟢 Correct under the stateful 1.x handshake — it changes lifetime, not protocol
  assumptions.
- 🔴 Lazy eviction means an entry can outlive its TTL while the process is idle.

### B — Connect per call for http/sse, pool only stdio

- 🟢 Removes the token dimension from the key entirely.
- 🔴 Under SDK 1.x every call pays an extra `initialize` round trip, and an SSE
  call re-establishes its stream per tool call. Only justified once the stateless
  core lands — it stays with #540.

### C — Spawn a stdio child per call

- 🟢 Trivially correct lifetime.
- 🔴 Process spawn + `initialize` on every tool call; for `npx`-launched servers
  that is seconds per call.

### D — A background reaper timer

- 🟢 Evicts on time regardless of traffic.
- 🔴 An interval outliving the work leaks into the server process and hangs
  `node --test`; `unref()` makes it silently unreliable instead.

### E — One shared `McpManager`

- 🟢 One pool to invalidate instead of two.
- 🔴 The two instances have deliberately different auth providers (the Builder
  router's `onAuthFailure` returns `null` so discover/test-call never emits a
  chat auth prompt). Merging them changes operator-facing behaviour and deserves
  its own decision.

## More Information

- Issue #563 — "Simplify MCP connection pooling".
- Implementation: `middleware/packages/harness-orchestrator/src/mcp/mcpClient.ts`
  (`McpManager`, `mcpPoolScopeMatches`, `MCP_POOL_IDLE_TTL_MS`),
  `middleware/src/routes/agentBuilder.ts` (`onMcpServerChanged`),
  `middleware/src/index.ts` (`runtimeMcpManager`).
- Tests: `middleware/test/mcpPool.test.ts`,
  `middleware/test/mcpPoolInvalidationRoutes.test.ts`.
- Deferred to #540: the SDK upgrade and the stateless per-call HTTP transport.
