# 0316 — Streamed tool outputs wait for the answer's egress check

## Status

Proposed

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

- **A — Hold the outputs:** while the answer may still be withheld, `tool_result` streams with
  `output: ''` and `sub_tool_result` is held. When the answer goes out, the full events are sent
  just before `done`. When it is withheld, they are dropped.
- **B — Retract event:** stream as before, and emit a new `tool_trace_retract` event before a
  withheld `done`.

## Decision Outcome

Chosen option: **A**, because it fails closed for every client. An output that is never sent
cannot be kept.

- "May still be withheld" means the turn has discretion state and is not a consultation run
  (`Orchestrator.answerMayBeWithheld()`, wired into `CliChatAgent` as `answerMayBeWithheld`).
  A turn without discretion state streams outputs live, as before.
- The hold is `ToolOutputHold` (`packages/harness-orchestrator/src/toolOutputHold.ts`). Both
  streaming paths use it: the orchestrator's stream wrapper and the CLI agent's event loop.
- The released `tool_result` repeats the live row's `id`. A client that maps results by id (the
  web UI) fills in the row it already shows. No new event type. The channel-sdk contract only
  gains the documented meaning of an empty output.
- Kernel consumers (plan step hooks, run trace, nudges) still see the real output. Only the
  client-facing stream is held.

### Consequences

- 🟢 **Good:** A withheld answer leaves no tool output in any client's trace.
- 🟢 **Good:** No client change is needed. Older web UIs and API callers get the safe behaviour.
- 🔴 **Bad:** In rooms with discretion state, the trace shows outputs only at the end of the
  turn, not while it runs.
- ⚪ **Neutral:** A client that renders a `tool_result` per event, not per id, shows two rows.
  None in the repo does.

## Pros and Cons of the Options

### A — Hold the outputs

- 🟢 Fails closed and needs no new wire event.
- 🔴 Live outputs are delayed in rooms with discretion state.

### B — Retract event

- 🟢 Keeps live outputs.
- 🔴 An output already sent stays with any client that ignores the event. It needs a
  channel-sdk version bump and a change in every client.

## More Information

- Issue #2342; tests `test/discretion/answerEgress.test.ts` and
  `test/discretion/recalledPlansCli.test.ts` (the `#2342` cases).
