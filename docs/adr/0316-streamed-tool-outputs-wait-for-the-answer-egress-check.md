# 0316 — Streamed tool outputs wait for the answer's egress check

## Status

Accepted

- **Date:** 2026-11-27
- **Deciders:** W42 cluster lead (issue #2342, decision after the recommendation, reversible)
- **Supersedes:** — (closes the streamed-trace residual that
  [ADR-0298](0298-file-tools-that-answer-into-the-turn-declare-no-effect.md) accepted)

## Context and Problem Statement

On the streaming paths (in-process `chatStream`, subscription CLI) every `tool_result` carried
the tool's output to the client as soon as the tool returned. When the people-egress check
(spec 2042 §5.11, [ADR-0019](0019-discretion-as-information-flow-control.md)) withholds the
answer at `done`, `text_retract` takes the text back, but the outputs already sent stay in the
client's tool trace. Those outputs include signed download links (bearer links) and raw read
results. How does a withheld turn keep its tool outputs from the client?

## Decision Drivers

- A withheld answer must leave nothing of what the turn read with the client. That is the
  point of the check.
- Not every client handles a retract event (API callers, older web UIs). A rule that depends
  on the client fails open.
- The live trace should still show which tools ran and when they finished.

## Considered Options

- **A — Hold every output:** while the turn has discretion state, stream `tool_result` without its
  output and send the full event just before `done`.
- **B — Retract event:** stream as before, and emit a new `tool_trace_retract` event before a
  withheld `done`.
- **C — Hold what the check would refuse now:** at each `tool_result` / `sub_tool_result`, ask
  the people-egress check with the labels collected so far. If it would let the answer through,
  stream the event live. If it would refuse, hold the event.

## Decision Outcome

Chosen option: **C**, because it fails closed for every client and leaves ordinary turns
unchanged. The check depends only on the turn's labels, and labels only grow. A tool's read
labels the turn inside its dispatch, before its `tool_result` is yielded. So an output that passes
the check when it arrives carries nothing the readers may not know, whatever the turn reads
later. An output that fails it means the answer will be withheld too.

- `ToolOutputHold` (`packages/harness-orchestrator/src/toolOutputHold.ts`) asks
  `Orchestrator.egressRefusesNow()` (in the CLI agent: the `egressRefusesNow` dep). The check
  answers `true` when it fails.
- A sub-agent's inner results (`sub_tool_result`) arrive before their parent tool returns and
  labels the turn. A shield bypass inside the sub-agent, for example, is classified only then. So
  inner results do not get their own check; they wait for their parent. They go out just before
  the parent's `tool_result` when that passes, and are held with it when it does not.
- A held `tool_result` is settled before `done`:
  - **Answer withheld:** it goes out once without its output (`output: ''`), so the row shows the
    call finished. Held `sub_tool_result`s are dropped, as are those whose parent never returned.
  - **Answer goes out after all:** the full events are sent.
- Every call yields exactly one `tool_result`, and the channel-sdk contract is unchanged.
- Both streaming paths use the hold: the orchestrator's stream wrapper and the CLI agent's event
  loop.
- Kernel consumers (plan step hooks, run trace, nudges) still see the real output. Only the
  client-facing stream is held.

### Consequences

- 🟢 **Good:** A withheld answer leaves no tool output in any client's trace.
- 🟢 **Good:** Turns the check lets through stream exactly as before: live, one result per call.
  No client changes.
- 🔴 **Bad:** A sub-agent's inner results no longer appear while it runs, only together with its
  own result.
- 🔴 **Bad:** One egress decision per tool result. It is cheap when the turn has no labels; the
  readers resolve once per turn.
- 🔴 **Bad (accepted residual):** `tool_use` / `sub_tool_use` inputs still stream live. A model
  that copies a value it read (a signed link) into its next call's arguments puts that value in
  the trace before the check. Tool inputs are model text, not tool output. Holding them would also
  hide which tool is running.

## Pros and Cons of the Options

### A — Hold every output

- 🟢 Simple.
- 🔴 Discretion state exists in almost every turn (web chat included), so every trace changes. It
  sends two `tool_result`s per call, and outputs no longer stream live (it broke the
  parallel-dispatch and tool-gate contracts in CI).

### B — Retract event

- 🟢 Keeps live outputs.
- 🔴 An output already sent stays with any client that ignores the event. It needs a
  channel-sdk version bump and a change in every client.

### C — Hold what the check would refuse now

- 🟢 Fails closed and leaves ordinary turns unchanged.
- 🔴 Relies on labels growing monotonically and being set inside the dispatch, both of which the
  discretion code already holds to.

## More Information

- Issue #2342; tests `test/discretion/answerEgress.test.ts` and
  `test/discretion/recalledPlansCli.test.ts` (the `#2342` cases).
