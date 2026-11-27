# 0279 — Channel chats see their routine deliveries through a kernel lookup by session scope

## Status

Proposed

- **Date:** 2026-11-27
- **Deciders:** omadia maintainers (wave 6, W34; #2316; decision after recommendation, reversible)
- **Supersedes:** [ADR-0244](0244-routine-deliveries-are-context-of-their-chat.md) in part: the
  consequence "only the web chat; Teams, Telegram, Slack and Discord deliveries are not yet part
  of their conversation's context"

## Context and Problem Statement

ADR-0244 made a routine's delivery context of the web chat it landed in: the web route reads
the chat document and adds the recent deliveries to the turn. A delivery into Teams, Telegram,
Slack, Discord or WhatsApp is sent by the channel plugin's proactive sender and never stored
where the kernel could read it per conversation; the next turn in that chat did not know the
report above it. The channel turn reaches the agent through the channel plugin (directly via
`chatAgent@1` or `CoreApi.handleTurnStream`), carrying only its session scope. How does a
channel chat's turn get its deliveries — without changing every channel plugin?

## Decision Drivers

- No change to the channel plugins (five repositories, one contract).
- The same block, framing and limits as the web chat (ADR-0244, ADR-0278).
- Only the conversation the delivery went to; no recall across chats for a plugin.
- No new store for message copies.

## Considered Options

- **A — Remember the creating conversation's session scope on the routine; a kernel lookup
  (`conversationContext@1`) reads the delivered runs of routines from that scope; a decorator
  in the agent chain fills `conversationContextHint`**
- **B — Each channel plugin records its deliveries and passes them with the next turn**
  (five plugins, five implementations)
- **C — Key by the channel's `conversationRef`** (channel-native shapes; a Teams reference
  changes per activity)

## Decision Outcome

Chosen option: **A**.

- Routines migration 0013 adds `routines.origin_scope`. `manage_routine` `create` stores the
  creating turn's `sessionScope` for a routine that writes back into that conversation on a
  channel (not for `web`, not for a `targetEmail` routine).
- `RoutineStore.recentDeliveriesForScope(scope, since, limit)` reads `routine_runs` with
  status `ok` and an answer, of routines with that `origin_scope` bound to the turn's agent,
  in the last 24 hours, at most three. Another agent in the same chat (an own bot) gets none:
  the output was produced under the first agent's grants (ADR-0016, ADR-0019). Whoever owns
  the routine: the delivery was posted into that conversation for its members.
- The kernel publishes `conversationContext@1` (`createChannelDeliveryContext`); a web chat
  scope yields nothing (the web route reads its document). The service is boundary-only
  (`BOUNDARY_ONLY_SERVICE_NAMES`, ADR-0257): it answers for any scope a caller names.
- The orchestrator plugin declares it in `optional_requires` and resolves it per turn;
  `wrapChatAgentWithConversationContext` sits outside the fast path (not for facilitators)
  and fills `conversationContextHint` when the caller set none. A failing lookup costs the
  block, never the turn. Masking and the drop rule are ADR-0278's.

### Consequences

- 🟢 **Good:** "explain point 2 of the report" works in a Teams or Telegram chat too.
- 🟢 **Good:** no channel plugin changes; new channels get it for free.
- 🔴 **Bad:** the block shows the run's answer, not the rendered card of a template routine.
- 🔴 **Bad:** routines created before this change have no `origin_scope` and stay without
  context until re-created.
- ⚪ **Neutral:** a channel whose session scope for the same chat changes (a different
  scope scheme between create and later turns) gets no block.

## More Information

`middleware/src/plugins/routines/migrations/0013_routines_origin_scope.sql`,
`middleware/src/plugins/routines/{routineStore,routineDeliveryContext,manageRoutineTool}.ts`,
`middleware/packages/harness-orchestrator/src/conversationContextAgent.ts`,
`middleware/packages/harness-orchestrator/src/{buildOrchestrator,plugin}.ts`,
`middleware/src/platform/pluginServiceGrants.ts`.
