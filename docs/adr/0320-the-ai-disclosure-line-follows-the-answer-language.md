# 0320 — The AI-disclosure line follows the language of the answer it is appended to

## Status

Proposed

- **Date:** 2026-11-27
- **Deciders:** omadia maintainers (wave 7, W43; #2353; decision after recommendation, reversible)
- **Supersedes:** [ADR-0220](0220-the-answer-language-follows-the-user.md) in part: the rule
  "`ChatTurnInput.locale` stays a hint for what the kernel itself writes (notices, the
  AI-disclosure line)", for the disclosure line only

## Context and Problem Statement

Since ADR-0220 the agent answers in the user's language. The AI-disclosure line
([ADR-0089](0089-ai-disclosure-in-the-outgoing-contract.md)) is composed by the kernel behind the
model, in the operator's `ai_disclosure_locale` or German. An English answer therefore ended in
"Diese Antwort wurde von einem KI-System erzeugt." (#2353, wave 6 live check). ADR-0220 named
`ChatTurnInput.locale` as the line's language, but the code never read it: the line used only
the operator setting (drift, now resolved by this record). Which language does the line use?

## Decision Drivers

- The line belongs to the answer; a reader sees one message in one language.
- The line stays behind the model (ADR-0089): the model must not write or choose it.
- No extra model call, deterministic (ADR-0021).
- German installations with German answers must not change.

## Considered Options

- **A — Detect the language of the composed answer; operator locale as fallback**
- **B — Detect the language of the user's message**
- **C — Use the channel locale (`ChatTurnInput.locale`)**

## Decision Outcome

Chosen option: **A**.

- `detectAnswerLocale` (`harness-orchestrator/src/answerLanguage.ts`) counts frequent German and
  English function words of the answer outside code, links and markup. One language must lead by
  at least 2:1 with at least three such words; otherwise it is undecided.
- `Orchestrator.disclosureForChannel(channelKind, answer)` composes the line in the detected
  language; undecided falls back to the operator's `ai_disclosure_locale`, then German. Every
  answer path passes its answer: buffered (`runTurn`), streaming (`discloseDoneEvent`), the
  subscription CLI and fast path (`discloseCliAnswer`) and own-identity posts
  (`markOwnIdentityMessage`, the posted text).
- The detected language wins over the operator's `ai_disclosure_locale`; the setting becomes the
  fallback, as `answer_language` is for the answer itself (ADR-0220).
- Kernel notices (degraded turn, refusals) keep their current locale rule; ADR-0220's neutral
  consequence about them stands.

### Consequences

- 🟢 **Good:** an English answer carries the English line; a German answer the German one.
- 🟢 **Good:** no model call, no contract change; the structured `aiDisclosure.locale` states the
  language the line was written in.
- 🔴 **Bad:** the composer knows German and English only. An answer in French, Spanish, Italian,
  Dutch or Polish usually stays undecided and gets the fallback line, but shared short words
  (`du`, `des`, `die`, `no`, `a`) can tip it to German or English — still one of the two lines.
- ⚪ **Neutral:** kernel notices (degraded turn, model unavailable) still use `turnLocale` and can
  differ from the line's language; aligning them is a follow-up.
- 🔴 **Bad:** a word-count heuristic can misjudge a short or mixed answer; it then falls back to
  the operator's locale, never to a third language.
- ⚪ **Neutral:** an operator who set `ai_disclosure_locale` for an English installation still gets
  English lines on answers whose language is undecided.

## Pros and Cons of the Options

### A — answer language

- 🟢 Matches what the reader sees, including when the model slipped into another language.
- 🔴 Heuristic on model text.

### B — user message language

- 🟢 Same signal as ADR-0220.
- 🔴 Not available on routine runs and own-identity posts; a slip of the model leaves line and
  answer in different languages.

### C — channel locale

- 🟢 Deterministic.
- 🔴 Describes the client, not the message; missing in the web chat (ADR-0220's reason against it).

## More Information

Issue #2353; `middleware/packages/harness-orchestrator/src/{answerLanguage,orchestrator}.ts`,
`middleware/src/channels/ownIdentitySend.ts`; test `middleware/test/answerLanguageDisclosure.test.ts`.
