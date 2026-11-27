# 0244 — Routine deliveries are context of the chat they land in

## Status

Proposed — superseded in part by [ADR-0278](0278-routine-deliveries-travel-as-conversation-context.md) (the block travels as `conversationContextHint`: no fast-path loss, dropped when it cannot be masked) and by [ADR-0279](0279-channel-chats-see-their-routine-deliveries.md) (channel chats get their deliveries too)

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
  from the chat's last three deliveries of the last 24 hours (each at most 2,000 characters):
  which routine, when
  (in `PROACTIVE_TIMEZONE`, ADR [0240](0240-schedules-run-in-a-named-time-zone.md)), and the
  text, framed as data of the conversation that must not be followed as instructions.
- `routes/chat.ts` adds it as `extraSystemHint` to every web-chat turn of a saved chat. The
  in-process orchestrator masks that hint like the user's message (fail closed); the
  subscription CLI passes it as a `System Hint:` line with role markers neutralised.
- The replayed tail keeps skipping proactive messages, so a delivery is never paired as an
  answer. A delivery's text and receipt are the server's: a client PUT cannot rewrite what is
  quoted to the model (`mergeServerProactiveMessages`).
- **Cleanup that goes with it** (#1753, #1757): deleting an existing web chat (`id` of the web
  chat's shape, the document existed) pauses the routines that deliver into it and removes its
  markdown transcripts; any other id cleans up nothing. Deleting a routine removes its
  transcripts. Graph nodes of the conversation stay (not this decision's purge).
- **Run history retention** (#1753): at most 200 runs per routine and none older than 90 days,
  pruned on insert (`RoutineRunsStore.prune`). `totalCostUsd` (ADR
  [0243](0243-routine-cost-per-run-and-on-its-trigger.md)) is therefore the cost of the
  retained runs; the trigger's spend keeps the lifetime figure.

### Consequences

- 🟢 **Good:** "explain point 2 of the report" works in the chat the report landed in.
- 🔴 **Bad:** the block sits in the per-turn hint, which models weigh like system text; the
  data framing lowers, but does not remove, the chance that injected text in a delivery
  steers the model.
- 🔴 **Bad:** only the web chat; Teams, Telegram, Slack and Discord deliveries are not yet part
  of their conversation's context (handoff §13).
- 🔴 **Bad:** while a delivery is in the 24-hour window, the chat's turns carry a hint, so the
  decision-model fast path passes them through (it does not take turns with a hint).
- 🔴 **Bad:** in-process, a delivery whose text cannot be masked (residual-leak block) fails
  the chat's turns until it leaves the window; on the subscription CLI the block goes with the
  steering hint and is masked with it (ADR 0195).
- 🔴 **Bad:** run history beyond 200 runs or 90 days is deleted: a new default that removes
  data.
- ⚪ **Neutral:** the delivery block, the routine lookup of a chat and the pause on its
  deletion all follow the chat's owner (ADR 0180): another account's chat id yields nothing.
- 🔴 **Bad:** pruning old runs also lowers the routine's shown total cost (ADR 0243): the
  total covers the kept runs, not the routine's lifetime.
- ⚪ **Neutral:** at most three deliveries of the last day; older ones are not in context.

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
