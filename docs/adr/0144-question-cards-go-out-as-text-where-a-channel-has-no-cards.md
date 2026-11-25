# 0144 — Where a channel shows no cards, the kernel posts the question as text and keeps it open

## Status

Accepted

- **Date:** 2026-11-25
- **Deciders:** Owner (byte5: channel parity, spec 2042 §5.14); issue #2086, implemented in
  #2142 (stream S6) and completed in #2172
- **Supersedes:** refines the sentence "The kernel keeps no posted cards" of
  [ADR-0037](0037-typed-question-cards-in-the-send-contract.md) for cards that go out as text

## Context and Problem Statement

ADR-0037 defines typed question cards: a plugin states the question, a channel renders it, the
answer comes back typed. Its capabilities carry `card.asText` for a channel that shows no
native cards, so the sender's instructions say "reply in the chat". ADR-0037 also stated that
the kernel keeps no posted cards. Spec 2042 §5.14 asks for channel parity: a card is an optional
enhancement, and every channel must have a path. This record is retroactive. Who turns a typed
reply in a channel without cards into the typed answer the engine expects? (Border:
facilitators.)

## Decision Drivers

- Counting stays deterministic (ADR-0021): no model reads the reply.
- A channel plugin should need no card code to take part.
- The engine that asked must not have to tell a card answer from a typed one.
- A question belongs to the identity that posted it (ADR-0013).

## Considered Options

- **A — The kernel renders the card as numbered text, stores the open question, and turns a
  fitting reply into the same `card_answer` event.**
- **B — Each channel plugin implements its own text fallback.**
- **C — The asking plugin parses free-text replies itself.**

## Decision Outcome

Chosen option: **A** (`middleware/src/channels/openCardQuestions.ts`,
`middleware/packages/harness-channel-sdk/src/questionCardText.ts`).

- **One renderer, one parser.** `renderCardAsText` produces the numbered message;
  `parseCardReply` turns the typed reply into the `CardAnswerValue`s a card submission would
  carry. Both live in the channel SDK and are deterministic.
- **The kernel answers for the channel.** With the open-question store wired,
  `capabilities(channelType)` reports
  `card: { kinds: TEXT_CARD_KINDS, maxQuestions: 1, update: false, asText: true }` for a
  provider without native cards, and `poll` likewise (`conversationSendService.ts`).
- **Only one-question cards** go out this way, because a typed reply answers one question
  (`canGoOutAsText`). An assignment qualifies when a reply can name the assignee: a fixed
  candidate list, or conversation members where a person can only take it over themselves.
- **The kernel keeps the question open.** `open_card_questions` (migration `0101`) holds
  channel type, conversation, the posted message id, the agent, the card and an expiry:
  `DEFAULT_OPEN_QUESTION_MS` (24 h) when the card names no close, never longer than
  `MAX_OPEN_QUESTION_MS` (7 days). Expired rows are deleted on the next write.
- **When a reply is taken.** It points at the question's message, or it addresses the bot
  (a mention, a private chat) and the question is the only open one of the conversation.
- **Identity.** A reply that reached another bot of the conversation is not an answer to this
  question.
- **Same semantics as a native card.** Anyone in the conversation may answer until it closes;
  each answer is one event and the receiver decides which one counts. A message that does not
  fit stays an ordinary message.
- **Polls too.** A poll that went out as text is answered as `{ optionId }` with the poll id
  as card id (`asPoll`).

### Consequences

- 🟢 **Good:** Every channel can carry single-question cards without card code of its own.
- 🟢 **Good:** The engine receives one event type for both paths.
- 🔴 **Bad:** The kernel now stores posted questions for up to seven days, which ADR-0037 had
  ruled out for native cards. Native cards are still not stored.
- 🔴 **Bad:** Multi-question cards have no text path: a card that cannot go out as text is
  refused and nothing is posted. A text card cannot be updated (`update: false`).
- 🔴 **Bad:** With several open questions in a conversation a reply must point at the
  question's message, or it is not taken.
- ⚪ **Neutral:** Names of conversation members are not resolvable from typed text; an
  assignment among members accepts only self-assignment.

## Pros and Cons of the Options

### A — Kernel text path with an open-question store

- 🟢 Parity by construction; deterministic.
- 🔴 A table and an expiry rule in the kernel.

### B — Per-channel fallback

- 🟢 Channel-specific wording.
- 🔴 The same parser in every channel plugin, drifting.

### C — The asking plugin parses replies

- 🟢 No kernel state.
- 🔴 Free-text interpretation in every engine; against ADR-0021 and ADR-0037.

## More Information

- Related: ADR-0021, ADR-0025, ADR-0037.
- Tests: `middleware/test/typedCardReplies.test.ts`, `middleware/test/openCardQuestions.pg.test.ts`,
  `middleware/test/agentOwnBotCardAnswer.test.ts`.
