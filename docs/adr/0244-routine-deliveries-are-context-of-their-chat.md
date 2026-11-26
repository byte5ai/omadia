# 0244 — Routine deliveries are context of the chat they land in

## Status

Proposed

- **Date:** 2026-11-26
- **Deciders:** omadia maintainers (wave 5, W22-23)
- **Supersedes:** —

## Context and Problem Statement

A routine delivers into a web chat by appending an assistant message with a `proactive`
marker to the chat document. The model's next turn in that chat never saw it: the run is
recorded under `routine:<id>`, and the replayed tail skips proactive messages on purpose so a
delivery is never paired as the answer to a question. A user who asked about the report
directly above got a confident "the routine has written nothing here" (#1756). How does a
delivery become part of the conversation without being mistaken for an answer or an
instruction?

## Decision Drivers

- The user must be able to quote and discuss a delivery in the same chat.
- A delivery is never the answer to the user's previous question.
- A delivery can carry tool output (a template's data sections): third-party text must not
  gain instruction authority.
- Privacy: the text passes the same prompt masking as the rest of the turn.

## Considered Options

- **A — the next turns get the recent deliveries as a labelled, quoted data block in the
  per-turn hint**
- **B — record each delivery as an assistant turn of the chat's scope (graph and tail)**
- **C — keep deliveries out of the model's context**

## Decision Outcome

Chosen option: **A**.

- `routineDeliveriesHint` (`src/plugins/routines/routineDeliveryContext.ts`) builds a block
  from the chat's last three deliveries (each at most 2,000 characters): which routine, when
  (in `PROACTIVE_TIMEZONE`, ADR [0240](0240-schedules-run-in-a-named-time-zone.md)), and the
  text, framed as data of the conversation that must not be followed as instructions.
- `routes/chat.ts` adds it as `extraSystemHint` to every web-chat turn of a saved chat. The
  in-process orchestrator masks that hint like the user's message (fail closed); the
  subscription CLI passes it as a `System Hint:` line with role markers neutralised.
- The replayed tail keeps skipping proactive messages, so a delivery is never paired as an
  answer.

### Consequences

- 🟢 **Good:** "explain point 2 of the report" works in the chat the report landed in.
- 🔴 **Bad:** the block sits in the per-turn hint, which models weigh like system text; the
  data framing lowers, but does not remove, the chance that injected text in a delivery
  steers the model.
- 🔴 **Bad:** only the web chat; Teams, Telegram, Slack and Discord deliveries are not yet part
  of their conversation's context (handoff §13).
- ⚪ **Neutral:** at most three deliveries; older ones are not in context.

## Pros and Cons of the Options

### A — labelled block

- 🟢 No schema change; the tail rule stays as it is.
- 🔴 Hint-level placement (see consequences).

### B — recorded turns

- 🟢 The graph would recall deliveries across chats.
- 🔴 A turn without a user message breaks the tail's pairing rule and the session log format.

### C — no context

- 🔴 The model denies what the user sees.

## More Information

Issue #1756; ADR [0146](0146-web-chat-is-a-kernel-route-with-ndjson-and-pinned-sessions.md),
[0162](0162-scope-id-typed-session-scope.md), [0242](0242-unattended-turns-for-routines-and-triggers.md).
