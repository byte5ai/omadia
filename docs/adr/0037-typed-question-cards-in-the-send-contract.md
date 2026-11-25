# 0037 — Question cards: typed questions out, typed answers in

## Status

Accepted — refined by [ADR-0144](0144-question-cards-go-out-as-text-where-a-channel-has-no-cards.md) (the kernel keeps open text questions)

- **Date:** 2026-11-19
- **Deciders:** Coordinator of the native facilitator rollout (#2043), design note
  "questionnaire cards in Teams"; PR #2105 (plugin-api 1.59.0, channel-sdk 0.3.4), refined by
  #2178 (`CardSupport.asText`, plugin-api 1.88.0). Refs #2089.

## Context and Problem Statement

A facilitator asks structured questions: choose one, choose several, rank, consent, assign,
or give a text, number or date. The send contract offered only text and polls. A plugin that
wanted a richer form had two ways out: write a channel's native card format itself (Adaptive
Cards for Teams, blocks for Slack), or parse free-text replies.

The first ties a plugin to each channel and bypasses the kernel's identity and scope checks
on what is posted. The second makes counting depend on a model reading replies, against
ADR-0021. Where does the shape of a question and of its answer live, and who checks it?

## Decision Drivers

- Plugins stay channel-agnostic (ADR-0014): they state what to ask, channels decide how.
- Counting and protocol assembly are deterministic (ADR-0021): an answer arrives typed.
- A post follows the identity and scope rules of every send (ADR-0013, ADR-0027).
- Channels differ in what they can show; a plugin must be able to ask before it sends.

## Considered Options

- **A — One typed card contract in plugin-api; channels declare support; the kernel validates
  and rebuilds the card and types the answer.**
- **B — Plugins send channel-native card payloads** through a pass-through field.
- **C — Extend polls** with more question kinds.

## Decision Outcome

Chosen option: **A**.

- **Types defined once** in plugin-api and re-exported by channel-sdk: `QuestionCard`,
  `CardQuestion` with kinds `single_choice`, `multiple_choice`, `ranking`, `consent`,
  `assignment`, `text`, `number`, `date`; `MessageCardAnswer` / `CardAnswerValue`; `CardUpdate`
  (`closed` with result lines, or `open` with a corrected card).
- **Capabilities.** A channel declares `SendProviderCapabilities.card` (`kinds`,
  `maxQuestions`, `update`, and `asText` when it shows no native cards). A plugin reads them
  through `ConversationSendService.capabilities(channelType)`.
- **The kernel checks.** A card is validated like a poll and rebuilt from the known fields.
  Refused with `channel_error`, nothing posted: an invalid card, a channel without card
  support, a kind the channel does not list, more questions than it shows (kernel cap 10), a
  card next to a poll.
- **Ids are restricted** to 1..64 characters of `A-Z a-z 0-9 _ -`, because adapters build input
  ids like `q1.rank1` and receive multiple choices as one comma-separated string.
- **Updates follow send identity:** the agent's own identity, a message subscription held by
  the calling plugin, and a provider that declares `asChannelKey` and `card.update`. The kernel
  keeps no posted cards; the channel updates only a message that identity posted.
- **Answers are typed.** A `card_answer` event stores the typed fields; an answer outside the
  contract's form refuses the event.
- **Scope.** Cards go to conversations only. A `card` in a direct message (`targetedSend`) is
  dropped before the channel sees it. `poll` and its answers are unchanged.

### Consequences

- 🟢 **Good:** A facilitator writes one card for every channel and counts typed answers
  without a model.
- 🟢 **Good:** Posting and updating a card stay under the kernel's identity and scope rules.
- 🔴 **Bad:** The question kinds are a closed list; a new kind is a plugin-api and channel-sdk
  change plus an adapter in every channel that wants it.
- 🔴 **Bad:** At #2105 no channel rendered a card; each channel adapter is its own work item.
- ⚪ **Neutral:** A channel without native cards declares `asText`, so the sender's
  instructions say "reply in the chat", not "use the card".

## Pros and Cons of the Options

### A — Typed contract, kernel validation

- 🟢 Channel-agnostic plugins, deterministic answers, one validation point.
- 🔴 The contract's expressiveness is the lowest common form of the channels.

### B — Channel-native payloads

- 🟢 Full use of each channel's card features.
- 🔴 Plugins per channel; the kernel cannot validate or type the answer.

### C — Extended polls

- 🟢 Reuses an existing path.
- 🔴 A poll is one question with options; ranking, consent, assignment and free fields do not
  fit without breaking its answers.

## More Information

- Code: `middleware/packages/plugin-api/src/questionCard.ts`.
- Tests: `middleware/test/questionCards.test.ts` and its Postgres leg.
- Related: ADR-0021, ADR-0025, ADR-0027.
