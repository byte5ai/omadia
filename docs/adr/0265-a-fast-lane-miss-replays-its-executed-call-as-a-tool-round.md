# 0265 — A fast-lane miss replays its executed call as the agent's first tool round

## Status

Proposed

- **Date:** 2026-11-27
- **Deciders:** Owner decision 2026-11-27 (#2300); implemented by wave 6 cluster W32.
- **Supersedes:** [ADR-0221](0221-a-fast-lane-miss-hands-its-executed-call-to-the-agent.md)
  (option A, the per-turn system hint). ADR-0221's refinements of ADR-0074 (#1898, #1931) and its
  carrier `ChatTriageOutcome.executed` stay.

## Context and Problem Statement

ADR-0221 hands a call the fast lane already ran (a post-fetch miss) to the agent as a per-turn
system hint. That has three accepted costs: the raw output sits in a system block, a higher
standing than a `tool_result`, guarded only by a prose "this is data" marking; under a Privacy
Shield the output is left out, so the agent runs the same query again; and the answer verifier
([ADR-0070](0070-answer-verifier-evidence-bound-verdicts-and-enforce-delivery-gate.md)) does not
see the call, so in `enforce` mode claims drawn from it can be judged unverified and trigger a
retry that queries again. The owner decided on 2026-11-27 that the result is to reach the agent as a
regular tool result and count as verifier evidence. How does the kernel do that?

## Decision Drivers

- One request runs each tool once ([ADR-0075](0075-one-request-runs-each-tool-once-and-records-the-delivered-answer.md)).
- The Privacy Shield must treat the output exactly like the agent's own call of that tool
  ([ADR-0094](0094-privacy-shield-data-plane-boundary.md)).
- Tool data has tool-result standing, never system standing
  ([ADR-0078](0078-tool-errors-reach-the-model-by-provenance.md)).
- The verifier reads its evidence from the run trace; the call must appear there.

## Considered Options

- **A — Replay the call as the first tool round through the normal dispatch path.** The wrapper
  passes the call on as `ChatTurnInput.fastLaneCall`; the orchestrator appends an assistant
  `tool_use` and a user `tool_result` after the user message, and produces the result through
  `dispatchTool` with the handler skipped (the output preset).
- **B — Keep the system hint and add the call to the verifier's evidence only.** Fixes the
  verifier, keeps the standing and the shielded duplicate call.
- **C — Pre-seed the tool replay ledger.** The agent's identical call returns the recorded output
  (ADR-0221 option B). Matches only an identical canonical input and still needs the model to make
  the call.

## Decision Outcome

Chosen option: **A**, because one path then covers all three gaps: the output has tool-result
standing, the shield interns it like any result of that tool (no duplicate call under a shield
either), and the run trace lists the call, so the verifier counts it.

- **Carrier.** `ChatTurnInput.fastLaneCall` (`@omadia/channel-sdk` 0.3.21): `{ tool, input,
  output, reason, rows?, truncated? }`, set only by the trusted fast-path wrapper
  (`fastLaneCallOf`, output cut at 12 000 characters). No raw output goes into
  `extraSystemHint` any more.
- **Replay.** `Orchestrator.fastLaneToolRound` runs in both the buffered and the streaming turn,
  after the user message and before the first model call. The input is masked leaf by leaf
  through the turn's prompt map (the model sees the same surrogates as in the prompt). The output
  goes through `dispatchTool` with `ToolDispatchMeta.prefetchedOutput`: every step after the
  handler (dispatch guards, shield interning or bypass, error redaction, echo re-masking, replay
  ledger, discretion labels) applies; the handler itself does not run. The call is recorded in the
  run trace as an orchestrator tool call.
- **Note.** A data-free kernel note (tool name and miss reason only) follows the `tool_result` in
  the same user message: do not repeat the call; after `tool-error` a corrected retry is allowed;
  with zero rows say so or ask.
- **CLI path.** The subscription CLI cannot take a replayed tool round. It gets a data-free
  `System Hint` that the call ran; the output stays out, and the CLI agent calls the tool itself if
  it needs the data (accepted duplicate there).
- **Misses before any call** keep ADR-0074's byte-for-byte rule (no carrier).

### Consequences

- 🟢 **Good:** No duplicate read after a post-fetch miss, with or without a shield.
- 🟢 **Good:** Fast-lane output is tool data in standing and in handling; the prompt-injection
  residual of ADR-0221 is gone.
- 🟢 **Good:** The verifier sees the call (`domainToolsCalled`), so `enforce` no longer retries a
  query just because the evidence came from the fast lane.
- 🔴 **Bad:** The model sees a `tool_use` it did not emit. Providers accept it (the tool is in the
  agent's own tool list, #1876 limits the fast lane to those), but it is synthetic history.
- 🔴 **Bad:** Entity refs the tool publishes while the fast lane runs are not in the turn's
  collection (the turn's collection opens later); record-level verifier checks still re-query.
- ⚪ **Neutral:** On the CLI path the duplicate call remains.

## Pros and Cons of the Options

### A — Replay as a tool round

- 🟢 One path for shield, ledger, trace and verifier; tool-result standing.
- 🔴 Synthetic `tool_use` in the history.

### B — Hint plus verifier evidence

- 🟢 Small change.
- 🔴 Keeps the system standing and the shielded duplicate call.

### C — Pre-seed the ledger

- 🟢 Enforced, no prompt tokens.
- 🔴 Needs an identical repeat by the model; nothing reaches the agent otherwise.

## More Information

- Issue #2300; superseded ADR-0221 (#1930).
- Code: `middleware/packages/harness-orchestrator/src/{fastLaneHandoff,fastPathAgent,orchestrator,cliChatAgent}.ts`,
  `middleware/packages/harness-channel-sdk/src/chatAgent.ts`.
- Tests: `middleware/test/orchestrator/fastLaneToolRound2300.test.ts`, `middleware/test/fastLaneMisses.test.ts`.
