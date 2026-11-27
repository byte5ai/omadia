# 0205 — MCP calls are re-sent only when safe, and a failed request ends only itself

## Status

Proposed

- **Date:** 2026-11-26
- **Deciders:** omadia maintainers (Welle 5, W09-10; decided after the recheck recommendation, reversible)
- **Supersedes:** in part [ADR-0008](0008-mcp-connection-lifetime.md) — its "End of life" rule
  "an entry is dropped … on a failed tool call"

## Context and Problem Statement

`McpManager.callTool` re-sent every `tools/call` once when the failure text looked
transient (timeout, "Connection closed", socket reset, "fetch failed"). Such a failure
cannot tell "the server never got it" from "the server ran it and the answer was lost", so
a non-idempotent write ran twice and nobody was told (#1904). On top, ADR-0008 dropped the
pooled entry on any failed tool call. Stdio servers and token-less HTTP servers share one
entry for every user, so one user's timeout closed the client under everyone else's
in-flight requests; the SDK rejected them with "Connection closed", and they were re-sent
too (#1905). The drop used `close(key)`, whose bare-id form also closes every token-scoped
entry of the server. Two adjacent gaps made it worse: no request carried a progress token,
so long tools always hit the 60 s idle timeout and were re-sent (#1919), and an HTTP 404
for a lost `Mcp-Session-Id` — a request the server provably never ran — was not retried at
all (#1945).

When may an MCP call be sent a second time, and what ends a pooled connection?

## Decision Drivers

- At-most-once beats at-least-once for writes: a duplicate Odoo/M365 write is customer-data
  damage; a lost answer is recoverable by asking the user to check.
- The flaky-hosted-proxy mitigation the retry was built for stays for tools where a
  second run is harmless.
- One caller's failure must not change another caller's outcome on a shared connection.
- The audit log has to show every request that reached the server.
- No new background timers, no SDK change (ADR-0008 drivers still hold).

## Considered Options

- **A — Re-send only declared-safe or provably-unsent requests; drop a connection only when it is gone**
- **B — Never re-send after a request was sent**
- **C — Keep the retry, add a client-generated idempotency key and trust servers to dedupe**

## Decision Outcome

Chosen option: **A**.

- **Re-send rule.** A request that reached the server and got no answer (timeout, dropped
  connection, socket reset, a transient-looking JSON-RPC error) is sent again — once, in the
  shared time budget — only when the server declared the tool `readOnlyHint: true` or
  `idempotentHint: true` in `tools/list`. The hints are the server's own claim about its
  own tool, which is the right authority for "running it twice is harmless"; they stay
  hints for every other purpose. Discovery keeps both hints on the descriptor
  (`McpToolDescriptor.idempotentHint` is new) and the persisted descriptor rehydrates them,
  so the rule survives a restart.
- **Provably unsent.** A failed connect (nothing was sent) and an HTTP 404 on a request
  that carried an `Mcp-Session-Id` (MCP session management: the server does not know the
  session and the client MUST start a new one) are re-sent for every tool, also under an
  exactly-once idempotency scope.
- **What counts as answerless.** A timeout, a dropped or reset connection, a
  transient-looking JSON-RPC error (`-32000`/`-32001`), and an HTTP 5xx from the transport
  (a proxy may answer 5xx after the upstream ran the call). Classified on the error itself,
  never on the composed failure text, which carries server and tool names.
- **Outcome unknown.** Every other answerless request returns
  `Error: outcome unknown — … Tell the user to check the result in the target system before
  trying again.` (`mcpOutcomeUnknownError`) and audits as `fail` with
  `outcome_unknown: <reason>`. Only a token-less call may instead get the connect prompt, when
  the auth provider has one (an OAuth server that refuses unauthenticated calls by dropping
  the connection).
- **One audit row per attempt.** An attempt that is followed by a re-send gets its own
  `fail` row that says it was sent again.
- **End of life (replaces the ADR-0008 bullet for tool calls).** A failed tool call drops
  its pooled entry only when the connection is really gone — the SDK reported the
  transport closed, or the server answered "session not found" — and only under the exact
  key the call used, and only while that key still holds the connection the call used
  (`dropEntryIfCurrent`). Timeouts and JSON-RPC errors leave the connection in place. The
  other ADR-0008 end-of-life events (failed connect, rejected stale token, explicit
  invalidation, idle TTL, `closeAll()`) are unchanged.
- **Progress.** Every `tools/call` passes an `onprogress` callback, which is what makes both
  SDK families send `_meta.progressToken`; a server that reports progress then keeps the
  idle timeout alive up to `OMADIA_MCP_CALL_MAX_TOTAL_TIMEOUT_MS`.

### Consequences

- 🟢 **Good:** An undeclared write tool runs at most once per call; the model and the call
  log both say when its outcome is unknown.
- 🟢 **Good:** One user's slow or failing call no longer interrupts or duplicates another
  user's call on a shared stdio or token-less HTTP connection.
- 🟢 **Good:** Long tools that report progress finish instead of timing out and running
  twice; a server restart no longer costs one failed call.
- 🔴 **Bad:** Tools without annotations lose the transparent retry. A hosted proxy that
  drops answers now surfaces "outcome unknown" for them instead of succeeding on the second
  try. Accepted: the retry could not tell that case from a lost write.
- 🔴 **Bad:** A server that lies about `idempotentHint` gets its tool re-sent. The damage is
  bounded to that server's own tool and is the server's declaration.
- 🔴 **Bad:** A hung stdio child is no longer killed by a call timeout; it stays pooled until
  the transport closes or an operator invalidates the server. While callers keep using it,
  it never idles out (every use refreshes the idle clock), so each call waits out its full
  timeout. Before, every timeout restarted it — and with it every neighbour's in-flight
  call. A drop after consecutive timeouts is left for a follow-up.
- ⚪ **Neutral:** `MCP_CALL_MAX_ATTEMPTS` stays 2 and the attempts still share one budget
  (ADR-0079), so the timeout hierarchy is unchanged.

## Pros and Cons of the Options

### A — Declared-safe or provably-unsent re-sends, drop only dead connections

- 🟢 Keeps the proxy mitigation where it is harmless, removes it where it duplicates.
- 🟢 Uses information the protocol already carries (annotations, HTTP status, transport close).
- 🔴 Depends on servers annotating their tools.

### B — Never re-send after a request was sent

- 🟢 Simplest, strictly at-most-once.
- 🔴 Regresses read tools behind flaky hosted proxies for no safety gain.

### C — Retry with an idempotency key and trust server dedupe

- 🟢 Would make writes safe on servers that dedupe.
- 🔴 MCP defines no idempotency field; no server is obliged to honour `_meta.idempotencyKey`,
  so for every real server today it is option "retry anyway".

## More Information

- Issues #1904, #1905, #1919, #1945.
- Implementation: `middleware/packages/harness-orchestrator/src/mcp/mcpClient.ts`
  (`callTool`, `isResendSafe`, `isSessionNotFound`, `dropEntryIfCurrent`,
  `mcpOutcomeUnknownError`, `requestPolicy`), `middleware/src/agents/subAgentToolHydration.ts`
  (`discoveredDescriptor`).
- Tests: `middleware/test/mcpCallResendPolicy.test.ts`, `middleware/test/mcpWriteIdempotency.test.ts`,
  `middleware/test/mcpClient.test.ts`.
- Related: [ADR-0008](0008-mcp-connection-lifetime.md), [ADR-0075](0075-one-request-runs-each-tool-once-and-records-the-delivered-answer.md),
  [ADR-0079](0079-tool-loop-bounds-loop-guard-finalize-and-timeout-hierarchy.md).
