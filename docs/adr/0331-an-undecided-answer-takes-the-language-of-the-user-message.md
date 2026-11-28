# 0331 — An undecided answer takes the language of the user message for the disclosure line

## Status

Accepted

- **Date:** 2026-11-27
- **Deciders:** W45 cluster lead (wave 8, issue #2367; decision after the recommendation, reversible)
- **Supersedes:** — (refines [ADR-0320](0320-the-ai-disclosure-line-follows-the-answer-language.md):
  the fallback for an undecided answer)

## Context and Problem Statement

Under [ADR-0320](0320-the-ai-disclosure-line-follows-the-answer-language.md) the AI-disclosure
line follows the language of the answer, and an answer that shows neither German nor English
clearly falls back to the operator's `ai_disclosure_locale` (default German). Short answers are
often undecided: the English routine delivery "It's 4:42 PM (Europe/Berlin) on Friday, November
27, 2026." has two English function words, below the minimum of three, and got the German line.
The answer itself follows the user ([ADR-0220](0220-the-answer-language-follows-the-user.md)),
so the user's message is the next best evidence. What decides the line's language when the
answer does not?

## Decision Drivers

- The line should match the answer the user reads, also for short answers.
- Deterministic and cheap, no model call ([ADR-0021](0021-deterministic-first-side-channels-and-uncluttered-answers.md)).
- The operator's `ai_disclosure_locale` stays the last fallback.

## Considered Options

- **A — Answer, then the turn's user message (a routine's prompt), then the operator locale;
  plus a lower minimum for a text that shows only one language.**
- **B — Only lower the minimum of `detectAnswerLocale`.**
- **C — Keep ADR-0320 as is.**

## Decision Outcome

Chosen option: **A**.

- `disclosureLocaleOf(answer, userMessage)` (`harness-orchestrator/src/answerLanguage.ts`):
  `detectAnswerLocale(answer) ?? detectAnswerLocale(userMessage)`.
- `Orchestrator.disclosureForChannel(channelKind, answer, userMessage?)`; every turn path passes
  `ChatTurnInput.userMessage` with the answer (`resolveTurnDisclosure`). A routine run's
  `userMessage` is its prompt. Own-identity posts have no user message and keep the ADR-0320
  rule.
- `detectAnswerLocale` decides a text with at least two function words of one language and none
  of the other; the 2:1 rule with three words stays for mixed text.
- Neither decides → `ai_disclosure_locale`, then German, as before.

### Consequences

- 🟢 **Good:** Short English answers to English messages and routines get the English line.
- 🟢 **Good:** The order matches ADR-0220's order for the answer itself.
- 🔴 **Bad:** A text with two English function words and no German one (for example a German
  sentence that quotes "on" and "it") now counts as English; the user-message fallback does not
  run for it. Accepted: such answers are rare and the line stays correct for the user's reading.
- ⚪ **Neutral:** Kernel notices are not changed by this ADR.

## Pros and Cons of the Options

### A — Answer, then user message, then operator locale

- 🟢 Uses the evidence the answer language rule already relies on.
- 🔴 One more input to the composer.

### B — Lower minimum only

- 🟢 One-line change.
- 🔴 Answers with no function words at all ("42", a table) stay on the operator locale even when
  the user wrote English.

### C — Keep ADR-0320

- 🔴 The live finding of #2367 stays.

## More Information

- Issue #2367 (W43 live check after #2360).
- Tests: `middleware/test/answerLanguageDisclosure.test.ts` (#2367 block).
