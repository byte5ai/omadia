# 0332 — Kernel notices in a turn follow the language of the user's message

## Status

Proposed

- **Date:** 2026-11-27
- **Deciders:** W45 cluster lead (wave 8, issue #2372; decision after the recommendation, reversible)
- **Supersedes:** [ADR-0220](0220-the-answer-language-follows-the-user.md) in part: its neutral
  consequence "kernel notices keep following the channel locale", for the notices the
  orchestrator writes into a turn

## Context and Problem Statement

The answer follows the language of the user's message
([ADR-0220](0220-the-answer-language-follows-the-user.md)), and so does the AI-disclosure line
([ADR-0320](0320-the-ai-disclosure-line-follows-the-answer-language.md),
[ADR-0331](0331-an-undecided-answer-takes-the-language-of-the-user-message.md)). The notices the
orchestrator writes into a turn instead of or next to the answer — the model-refusal notice, the
withheld-answer text of the people egress check, the degraded-turn notice, the subscription CLI's
refusal under `OMADIA_PRIVACY_FORCE_GUARDED` — took their language from `turnLocale(input)`,
which resolved only the operator's `ai_disclosure_locale` (default German). ADR-0220 assumed
they follow the channel locale; the code did not read it there either. An English user got an
English answer and a German refusal. Which language does a kernel notice in a turn use?

## Decision Drivers

- A notice replaces or sits next to the answer; it should be readable in the same language.
- Deterministic, no model call ([ADR-0021](0021-deterministic-first-side-channels-and-uncluttered-answers.md)).
- One place decides, so all notices of a turn agree.

## Considered Options

- **A — The language of the user's message (`detectAnswerLocale(input.userMessage)`), else the
  operator locale.**
- **B — The channel's `ChatTurnInput.locale`, else the operator locale.**
- **C — Keep the operator locale.**

## Decision Outcome

Chosen option: **A**, because it is the evidence the answer itself follows, and it exists on
every surface (the channel locale is missing on the web chat and API turns).

- `Orchestrator.turnLocale(input)` (also `noticeLocale` for the CLI) returns
  `detectAnswerLocale(input.userMessage) ?? ai_disclosure_locale`. Composers still default to
  German.
- The identity guard's notice (`guardedChatAgent`) keeps its order: the channel's
  `input.locale`, else `noticeLocale()`.
- The text a withheld answer leaves in the stored transcript (`answerWithheldText` in
  `beforeTurnWritten`) is memory, not a notice to the user, and stays on the operator locale.

### Consequences

- 🟢 **Good:** Refusal, withheld and degraded notices match the language the user wrote in.
- 🔴 **Bad:** A message without a clear German or English signal ("ok", a name) still gets the
  operator locale, even mid-conversation in another language. The answer has the conversation as
  context; the notice does not.
- ⚪ **Neutral:** Web UI notices rendered by the client keep the UI language (`web-ui` i18n).

## Pros and Cons of the Options

### A — User message language

- 🟢 Same evidence as the answer; works on every surface.
- 🔴 Short messages stay undecided.

### B — Channel locale

- 🟢 Available on Teams.
- 🔴 Missing on the web chat and API; a German Teams client can host an English conversation.

### C — Operator locale

- 🔴 The finding of #2372 stays.

## More Information

- Issue #2372 (found while fixing #2367).
- Tests: `middleware/test/orchestrator/modelRefusalNotice.test.ts` (#2372 case).
