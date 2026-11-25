# 0143 — The public MCP endpoint is stateless, dark by default, and a key reaches only the tools an operator named

## Status

Accepted

- **Date:** 2026-11-25
- **Deciders:** omadia maintainers; issue #542 (wave W2-3 of the MCP 2026-07-28 readiness
  work), implemented in #550
- **Supersedes:** —

## Context and Problem Statement

omadia consumes MCP servers (ADR-0007 to ADR-0009). Issue #542 asked for the other direction:
omadia's own tools offered to an external MCP client. The kernel already had an MCP server,
`LoopbackMcpServer`, but it binds `127.0.0.1`, authenticates one static bearer and exposes the
full native tool registry to a local process. The native tool registry is process-wide; there
was no per-agent or per-caller allowlist. This record is retroactive. On what footing may the
tool layer, including write tools, be reachable from the internet?

## Decision Drivers

- This is the surface with the largest blast radius in the MCP cluster.
- Default deny at every step; a read problem must never become a grant.
- Several instances behind a load balancer must be able to serve any request.
- A tool name a caller cannot use is itself a disclosure of which integrations an install runs.
- One key store and one revoke with the public chat API.

## Considered Options

- **A — A separate `PublicMcpServer`: stateless Streamable HTTP, mounted only when enabled,
  four independent gates, a per-key binding table.**
- **B — A flag on `LoopbackMcpServer`** that binds it publicly.
- **C — Stateful MCP sessions** (`Mcp-Session-Id`) with per-session authorization.

## Decision Outcome

Chosen option: **A** (`middleware/src/mcp/`).

- **Dark by default.** `PUBLIC_MCP_ENABLED=false` mounts no router at all, "a stronger
  guarantee than mounting one that answers 403" (`middleware/src/config.ts`).
- **One route, no session.** `POST /api/v1/mcp`; every POST is answered on its own with a
  request-scoped server and transport; other methods get `405`. No `initialize` is needed and
  no session id issued. The session gate exempts exactly this path (`auth/publicPaths.ts`).
- **Four gates, in order.** (1) *Authentication*: `requireApiKey`, the keys of
  [ADR-0141](0141-public-api-channel-with-scoped-api-keys.md), read through a verify-only store: the endpoint
  cannot mint or revoke. (2) *Binding*: an enabled `public_mcp_key_bindings` row (migration
  `0033`) naming one agent; no row, a disabled or a malformed row all mean zero tools.
  (3) *Allowlist*: the tool is named in the row and advertised by that agent; exact names, no
  patterns. (4) *Scope*: `mcp:list`, `mcp:invoke`, and for a write tool its own
  `mcp:write:<tool>`. `*` never grants a write scope.
- **`tools/list` equals what the key can call.** List and call use the same predicate
  (`callableToolNames`), so the list is the caller's capability set, not a catalogue.
- **Scope and row are both required** and live in different stores (vault and database) with
  different write paths, so a mistake in one is not a mistake in both.
- **Budgets.** Body 8 MB (`MAX_REQUEST_BYTES`), 30 s per tool (`DEFAULT_TOOL_TIMEOUT_MS`), four
  concurrent calls for the whole endpoint (`DEFAULT_MAX_CONCURRENT_CALLS`), the key's
  per-minute budget, and a separate write budget per binding (default 5, at most 600 per
  minute). `tools/list` advertises `ttlMs` of 60 s.
- **Idempotency is advisory.** `params._meta.idempotencyKey` deduplicates write tools within
  one process (about 15 minutes, about 1,000 records). It is documented as retry safety, not
  exactly-once.
- **Audit.** Every call and refusal goes to the MCP call log as `apikey:<id>`
  (`mcp_call_log.caller_kind` widened in `0033`); arguments and results are not recorded.

### Consequences

- 🟢 **Good:** Integration-backed and write tools stay unreachable until an operator names them
  for one key.
- 🟢 **Good:** Any instance serves any request; no sticky sessions.
- 🔴 **Bad:** Two requests with the same idempotency key can both run on different instances.
- 🔴 **Bad:** A revoked or changed binding can stay visible in a client's cached list for up to
  60 s (the call itself is checked every time).
- 🔴 **Bad:** Per-request server construction costs more than a pooled session.
- ⚪ **Neutral:** `requireApiKey` gets no route-level scope; both MCP scopes are checked inside
  the JSON-RPC handlers where the method is known.

## Pros and Cons of the Options

### A — Separate stateless server, four gates

- 🟢 The dangerous default is not one boolean away from an existing class.
- 🔴 The stateless transport lifecycle is copied from the loopback server, not shared.

### B — Flag on the loopback server

- 🟢 Least code.
- 🔴 Its trust boundary is "any local process that can read the 0600 bearer"; none of it
  transfers to an internet route.

### C — Stateful sessions

- 🟢 Fewer handshakes for chatty clients.
- 🔴 Session affinity behind a load balancer and server-side state to expire and protect.

## More Information

- Related: ADR-0005, ADR-0008, ADR-0009, ADR-0016;
  [ADR-0142](0142-public-mcp-endpoint-fails-closed-on-privacy.md), [ADR-0138](0138-mcp-input-required-ends-the-call-and-is-replayed.md).
- Consumer documentation: `middleware/src/mcp/README.md`. Operator bindings:
  `middleware/src/routes/publicMcpBindingsRouter.ts`, `middleware/src/mcp/publicMcpKeyBindingsAdmin.ts`.
- Tests: `middleware/test/publicMcp/` (`publicMcpEndpoint.e2e.test.ts`, `publicMcpScopes.test.ts`,
  `publicMcpKeyBindings.test.ts`, `publicMcpBodyCap.test.ts`, `mutation-check.sh`).
