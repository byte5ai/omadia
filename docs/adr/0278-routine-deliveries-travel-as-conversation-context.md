# 0278 — Routine deliveries travel as conversation context: no fast-path loss, dropped when they cannot be masked

## Status

Proposed

- **Date:** 2026-11-27
- **Deciders:** omadia maintainers (wave 6, W34; #2317; decision after recommendation, reversible)
- **Supersedes:** [ADR-0244](0244-routine-deliveries-are-context-of-their-chat.md) in part: "`routes/chat.ts`
  adds it as `extraSystemHint`" and the consequences "the decision-model fast path passes them
  through" and "a delivery whose text cannot be masked … fails the chat's turns until it leaves
  the window"

## Context and Problem Statement

ADR-0244 put the chat's recent routine deliveries into the per-turn `extraSystemHint`. Two
side effects followed. The fast path passes every turn with an `extraSystemHint` through to
the full agent, so a chat that received one delivery lost the fast path for 24 hours. And
the hint is wire content that fails the turn closed when it cannot be masked, so one delivery
the masker blocked (a residual-leak verdict) broke every turn of that chat for a day. How does
the delivery block reach the model without either?

## Decision Drivers

- A delivery is context, not an instruction for this turn.
- Unmasked text must never reach the model (fail closed for the data).
- The user's turn must not fail because of a message they did not write.
- Other callers of `extraSystemHint` (verifier corrections, handoffs) keep their semantics.

## Considered Options

- **A — A separate optional field `ChatTurnInput.conversationContextHint`** (channel-sdk
  0.3.19): not a fast-path pass-through reason; masked like the caller hint, dropped from the
  turn when masking fails
- **B — Keep `extraSystemHint`, exempt it in the fast path by content and catch the mask
  error there** (the hint then mixes data with instructions; a verifier correction appended
  to it would be dropped with it)
- **C — Shorten the window** (both effects stay, only shorter)

## Decision Outcome

Chosen option: **A**.

- `routes/chat.ts` passes `routineDeliveriesHint` as `conversationContextHint`.
- `passThroughReason` (fast path) does not list it: the triage may answer a data question in a
  chat that had a delivery today; a turn it hands on keeps the field. The triage itself never
  sees the block (it sees only the user's message, as before).
- The in-process orchestrator masks it through the turn's prompt map
  (`wireConversationContextHint`) and joins it to the caller hint; when masking is blocked or
  throws, the block is left out of this turn and a log line (no text) says so. The
  subscription CLI does the same in `maskTurnInput` and renders it as its own `System Hint:`
  line with role markers neutralised.

### Consequences

- 🟢 **Good:** a delivery no longer disables the fast path for its chat.
- 🟢 **Good:** a delivery the masker refuses costs only its own context; the turn runs.
- 🔴 **Bad:** the fast-path triage does not see the block either: a data question that also
  refers to a delivery ("the invoices from the report, as a table") may be answered from the
  tools without it. Accepted: the triage answers only single read queries, and a question
  about the report itself is no such query, so it goes to the agent with the block.
- 🔴 **Bad:** in such a turn the model does not see the deliveries; a question about one may
  get "I don't see that report" until a later delivery replaces it in the window.
- ⚪ **Neutral:** the data framing and the prompt-injection residual of ADR-0244 are
  unchanged.

## More Information

`middleware/packages/harness-channel-sdk/src/chatAgent.ts`,
`middleware/packages/harness-orchestrator/src/{orchestrator,cliChatAgent,fastPathAgent}.ts`,
`middleware/src/routes/chat.ts`, `middleware/src/plugins/routines/routineDeliveryContext.ts`.
