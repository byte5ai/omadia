# 0079 — The tool loop is bounded by a loop guard, a finalize pass and a timeout hierarchy checked at boot

## Status

Accepted

- **Date:** 2026-11-25
- **Deciders:** omadia maintainers; #240 (cap 25→100, loop guard, best-effort finalize), #550
  (timeout hierarchy, W3-A/W4), #1211 (finalize pass shape)
- **Supersedes:** —

## Context and Problem Statement

An agent turn is a loop: the model calls tools, reads results, calls again. With a low iteration
cap (12, then 25) honest multi-step work ended in a raw "exceeded maxToolIterations" error. With
a high cap a model that repeats the same call burns the whole budget. Around each tool call sit
several timeouts owned by different layers; when the outer one was tighter than the inner one, an
MCP call that legitimately used its allowance died on a generic error. This record is retroactive.

How is a turn bounded without cutting honest long turns, and what does the user get when a bound
is hit?

## Decision Drivers

- Multi-step work must be able to finish.
- A runaway loop must stop early, and the user must still get an answer.
- A misconfigured bound must be reported, not silently replaced.
- Bounds must not break the prompt cache of the turn.

## Considered Options

- **A — High iteration cap as a floor, a round-loop guard, a finalize pass on every bound, a
  timeout hierarchy asserted at boot.**
- **B — Low iteration cap, error on exhaustion.**
- **C — Wall-clock budget as the primary bound.**

## Decision Outcome

Chosen option: **A**.

- **Iteration cap 100, as a floor.** `DEFAULT_MAX_ITERATIONS = 100`
  (`harness-orchestrator/src/plugin.ts`); a smaller persisted `max_tool_iterations` is raised to
  it, because stale installs carried 12.
- **Loop guard** (`loopGuard.ts`). Per iteration the batch of calls (name plus canonical input,
  order-independent) and its results are hashed. An identical batch with identical results is the
  loop signal: at 3 repeats the model gets one steer per signature, at 5 the guard stops tool use.
  Different arguments never trip it.
- **Finalize pass.** When the cap is reached, the guard stops, or the optional wall-clock budget
  is exceeded, the last request must end in text: a provider that declares
  `capabilities.toolChoiceNone` keeps the full tool list with `tool_choice: none` (the cached
  prefix survives); every other provider gets `tools: []`. The directive rides in the per-turn
  system hint, never in a user message.
- **Wall-clock budget is opt-in.** `max_turn_seconds` defaults to 0 (off).
- **Timeout hierarchy.** Inner `OMADIA_MCP_CALL_TIMEOUT_MS` (60 s idle per request), middle
  `OMADIA_MCP_CALL_MAX_TOTAL_TIMEOUT_MS` (180 s), outer `OMADIA_TOOL_DISPATCH_TIMEOUT_MS`
  (240 s, 0 = none). The outer bound must be strictly looser than the MCP layer's worst case with
  retries included. `assertTimeoutHierarchy()` runs at boot and throws; the resolver does not
  clamp, because a substituted number hides the misconfiguration.
- **A deadline is a tool result.** A call past its dispatch deadline answers the model with an
  `Error:` result; its late result and late sub-agent events are discarded.
- **Mid-turn steering** (`steeringBus.ts`): `POST /chat/steer` buffers up to 8 messages of at most
  4000 characters for a live turn; the loop drains them at the top of each iteration. The bus is
  process-local.

### Consequences

- 🟢 **Good:** Long honest turns finish; a repeating loop ends near iteration 5 with a best-effort
  answer instead of an error.
- 🟢 **Good:** An incoherent timeout configuration refuses to start instead of surfacing weeks
  later as unexplained MCP failures.
- 🔴 **Bad:** An operator cannot lower the iteration cap below 100; only the wall-clock budget
  limits a turn further.
- 🔴 **Bad:** The guard sees only identical arguments with identical results; a loop that varies
  its input slightly runs to the cap.
- 🔴 **Bad:** A deployment with an env override that breaks the hierarchy does not boot.
- ⚪ **Neutral:** Steering needs sticky sessions in a multi-instance deployment; a shared bus is
  out of scope. Tools that take minutes use [ADR-0133](0133-long-running-tool-tasks-behind-a-task-store-seam.md).

## Pros and Cons of the Options

### A — Floor, guard, finalize, boot check

- 🟢 Each bound degrades into an answer or a clear startup error.
- 🔴 Several interacting knobs.

### B — Low cap, error

- 🟢 Predictable cost ceiling.
- 🔴 Was the status quo; multi-step tasks failed with a raw error.

### C — Wall-clock first

- 🟢 Easy to reason about for operators.
- 🔴 Truncates honest long turns; kept as an opt-in only.

## More Information

- Code: `middleware/packages/harness-orchestrator/src/loopGuard.ts`, `steeringBus.ts`,
  `orchestrator.ts` (`assertTimeoutHierarchy`, `resolveToolDispatchTimeoutMs`, `toolParamsFor`,
  `FINALIZE_DIRECTIVE`), `plugin.ts` (defaults and floors), `mcp/mcpClient.ts`
  (`resolveMcpCallTimeouts`).
- Tests: `middleware/test/orchestrator/loopGuard.test.ts`, `finalizePass1211.test.ts`,
  `timeoutHierarchy.test.ts`, `toolDispatchDeadline.test.ts`.
- Related: ADR-0008 (MCP connection lifetime), ADR-0017 (runaway protection for the CLI loop),
  [ADR-0077](0077-prompt-cache-layout-and-per-turn-tool-advertisement.md).
