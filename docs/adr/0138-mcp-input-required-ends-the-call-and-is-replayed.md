# 0138 — MCP `input_required`: nothing is parked across a wait; the call ends and is replayed, bounded to one round

## Status

Accepted

- **Date:** 2026-11-25
- **Deciders:** omadia maintainers; issue #544 (client and server half, #550), #562 phase 3
  (2026-07-28 dialect on the client), #700 (2026-07-28 dialect on the public endpoint, #704)
- **Supersedes:** —

## Context and Problem Statement

An MCP tool can answer `tools/call` with `resultType: "input_required"`: it cannot finish
without one more value from a human. The protocol imagines the client collecting the input and
retrying while the call is logically still in flight. omadia meets this shape twice: as a
client of remote MCP servers during a chat turn, and as a server on the public MCP endpoint.
The orchestrator has no turn suspend/resume store, and the public endpoint is stateless. The
2026-07-28 revision then standardised a different wire shape than the one omadia had shipped.
This record is retroactive. How is mid-call input handled in both directions, and in which
dialect? (Border: orchestrator.)

## Decision Drivers

- No connection held open past proxy and channel idle timeouts.
- No cross-user reuse of a parked call.
- A model and a server must not be able to bounce a user indefinitely.
- Tools should not have to know which protocol era their caller speaks.

## Considered Options

- **A — End the call, render a card, replay the original call with the answers; bound to one
  round; choose the dialect by the connection's protocol era.**
- **B — Suspend the turn** and resume the in-flight call when the answer arrives.
- **C — Treat `input_required` as a tool error.**

## Decision Outcome

Chosen option: **A**.

- **As a client** (`middleware/packages/harness-orchestrator/src/mcp/pendingMcpInput.ts`): the
  turn ends, the channel renders an input card, and the answer arrives as a fresh turn that
  replays the call, the pattern `ask_user_choice` already uses. The parked record is keyed by
  the triple `{userId, sessionId, correlationId}`; a lookup that differs in any component
  misses. It lives `PENDING_MCP_INPUT_TTL_MS` (15 min), at most `PENDING_MCP_INPUT_MAX_ENTRIES`
  (500) records, at most `MCP_INPUT_REQUEST_MAX_FIELDS` (8) fields, and
  `MCP_INPUT_MAX_REPLAY_DEPTH` is 1: a replay that asks again is refused.
- **As a server** (`middleware/src/mcp/publicMcpInputRequired.ts`): a dispatched tool signals
  the need in-band with the `_pendingInputRequest` JSON sentinel, the convention
  `_pendingUserChoice` uses, instead of a third `ToolDispatchResult` variant. The endpoint
  renders it as `input_required` and also fills `content`, so an older client shows the
  question. The client retries the original request with `inputResponses`; the server parks
  nothing.
- **Two dialects, chosen by era, not by configuration.** A 2025-era request gets omadia's
  original shape (a flat array of fields, answers in `arguments.inputResponses`), byte for
  byte. A 2026-07-28 request gets the revision's shape (a map with one embedded
  `elicitation/create` request, answers as top-level `inputResponses`). The translation stops
  at `publicMcpModernMrtr.ts`; the tool's view is identical in both.
- **A signed `requestState` on the modern dialect.** It carries only `{ tool, round }`, is
  HMAC-signed, bound to the API key and the method, and valid for one hour
  (`publicMcpRequestState.ts`). The arguments are deliberately not in it: the codec signs, it
  does not encrypt. The signed round makes the one-round cap independent of what the caller
  strips.

### Consequences

- 🟢 **Good:** Works on a stateless endpoint and without a suspend store; any instance serves
  the retry.
- 🟢 **Good:** One tool implementation for both protocol eras and both directions
  (`inputResponses` is the same key on the client half).
- 🔴 **Bad:** The replay is a new `tools/call`, possibly on a rebuilt connection. A stdio
  server that kept process state for the original call sees a fresh call, not a continuation.
- 🔴 **Bad:** A tool must be able to finish from `{...originalArgs, inputResponses}` alone.
- 🔴 **Bad:** On the 2025 dialect the round cap is inferred from the presence of
  `inputResponses`; a caller that strips the key gets another card.
- 🔴 **Bad:** The modern elicitation schema has no masked-input concept, so `secret: true`
  cannot be expressed there and is named in the prose instead.

## Pros and Cons of the Options

### A — End, card, replay, one round

- 🟢 No held connections, no shared parked state across users.
- 🔴 Not the in-flight continuation the protocol describes.

### B — Suspend and resume

- 🟢 True continuation semantics.
- 🔴 `turnContext` is an `AsyncLocalStorage` whose lifetime is the turn; parking would hold an
  HTTP or Teams connection open, or need a suspend store that does not exist.

### C — Tool error

- 🟢 Nothing to build.
- 🔴 The human gets a message no machine can act on, or the model guesses the value.

## More Information

- Related: ADR-0008, ADR-0009, [ADR-0143](0143-public-mcp-endpoint-is-stateless-and-default-deny.md).
- Tests: `middleware/test/orchestrator/mcpInputRequired.test.ts`, `middleware/test/mcpPendingInput.test.ts`,
  `middleware/test/mcpModernMrtr.test.ts`, `middleware/test/publicMcp/publicMcpInputRequired.test.ts`,
  `middleware/test/publicMcp/publicMcpModernMrtr.test.ts`.
