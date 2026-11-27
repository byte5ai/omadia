# 0212 — The public MCP endpoint answers a tool error as a tool error, without its text

## Status

Proposed

- **Date:** 2026-11-26
- **Deciders:** omadia maintainers; Welle 5 cluster W11-12, issue #1937
- **Supersedes:** [ADR-0142](0142-public-mcp-endpoint-fails-closed-on-privacy.md) in part (the
  "returned `Error:` text" bullet of "Tool errors")

## Context and Problem Statement

ADR-0142 refuses every result on `POST /api/v1/mcp` that did not cross the Privacy Shield
boundary. A tool that *reports* an error (an external MCP tool's `isError` result, an upstream
JSON-RPC error, a server that still needs an OAuth connection) produces an `Error:` text. The
public gate answers tool-error redaction with `withheld`, so that text never counts as masked,
and ADR-0142 recorded the consequence: "the result is refused like any other unmasked one".
The caller then gets the JSON-RPC error `-32603` "privacy masking did not run", the call log
says "privacy masking skipped", and integrators report a privacy outage for an ordinary tool
failure (#1937). How should the endpoint answer a tool error without serving its text?

## Decision Drivers

- No byte a tool produced reaches the caller unmasked (ADR-0142 stays the invariant).
- The MCP spec reports tool execution errors in the result (`isError: true`), not as protocol
  errors.
- "privacy masking …" must mean that masking really did not run on data that would be served.

## Considered Options

- **A — Serve a generic tool-error result.** The dispatcher flags a fulfilled control-flow
  result (`Error:` text, connect prompt) `isError` with `origin: 'tool'`. The endpoint answers
  such a result with `isError: true` and a fixed text naming only the tool; the tool's own text
  is dropped. The call log records "tool reported an error".
- **B — Serve the redacted error text.** Run the real tool-error redactor and serve its output.
- **C — Keep the refusal, relabel it.** Same `-32603`, better wording.

## Decision Outcome

Chosen option: **A**, because it serves no tool-authored byte (the generic text is authored by
the endpoint) and still gives the caller the outcome the spec defines.

- `ToolDispatchService.afterDispatch` returns guarded control-flow results as
  `{ isError: true, origin: 'tool' }` (`fromToolError`). Under a privacy handle the text is
  already the redacted or withheld form; the flag adds no data.
- `PublicMcpServer` exempts such a result from the "masking did not run" refusal and replaces
  its content with `toolReportedErrorMessage(name)` before it is returned
  (`servable`). Error results are never retained by the idempotency store, so a replay cannot
  carry one.
- A masking **failure** (`maskingFailed()`) is still refused with `-32603`, and every other
  unmasked result still is too.
- Without a gate (no provider and `PUBLIC_MCP_ALLOW_WITHOUT_PRIVACY_MASKING=true`) results go
  out unchanged, as before.

### Consequences

- 🟢 **Good:** An integrator sees a tool failure as a tool failure; an operator sees
  "tool reported an error" in the call log and looks at the tool, not at the Privacy Shield.
- 🟢 **Good:** The ADR-0142 invariant holds: the served text carries the tool name only.
- 🔴 **Bad:** The caller learns nothing about *why* the tool failed; the operator has the
  server log.
- ⚪ **Neutral:** The loopback MCP server now forwards `isError` for these results to the
  CLI, which matches what the text already said.

## Pros and Cons of the Options

### A — Serve a generic tool-error result

- 🟢 Spec-shaped answer, no tool data served.
- 🔴 No error detail for the caller.

### B — Serve the redacted error text

- 🟢 Useful detail for the caller.
- 🔴 Spends a detector call on an internet-facing path and serves tool text that only a
  free-text redactor has looked at; ADR-0142 chose not to do that, and nothing changed.

### C — Keep the refusal, relabel it

- 🟢 Smallest change.
- 🔴 Still a protocol error for a tool error; clients that retry `-32603` keep retrying.

## More Information

`middleware/packages/harness-orchestrator/src/toolDispatchService.ts` (`fromToolError`),
`middleware/src/mcp/publicMcpServer.ts` (`servable`, `isToolReportedError`), tests in
`middleware/test/publicMcp/publicMcpWave5Fixes.e2e.test.ts`. Endpoint README section
"What tool results look like".
