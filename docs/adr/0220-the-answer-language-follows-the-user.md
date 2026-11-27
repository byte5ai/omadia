# 0220 — The answer language follows the user, with an operator fallback

## Status

Accepted — superseded in part by [ADR-0320](0320-the-ai-disclosure-line-follows-the-answer-language.md) (the AI-disclosure line follows the answer's language, not `ChatTurnInput.locale`)

- **Date:** 2026-11-26
- **Deciders:** Wave 5 cluster W15-17, decided after the recheck's recommendation under the
  owner's autonomy grant for wave 5 (reversible); tracked by #1992.
- **Supersedes:** —

## Context and Problem Statement

The agent's system prompt said "Sprache: Antworte immer auf Deutsch, außer der Nutzer wechselt
explizit die Sprache" (`orchestrator.ts`). A user who writes English gets German until they ask
for English, and there is no setting for an installation whose users are not German speakers.
`ChatTurnInput.locale` exists, but channels fill it unevenly (a Teams client locale, a Telegram
`language_code`, nothing in the web chat), and today it only picks the language of kernel notices
and of the AI-disclosure line ([ADR-0089](0089-ai-disclosure-in-the-outgoing-contract.md)).

Which signal decides the language an agent answers in?

## Decision Drivers

- A good colleague answers in the language they were spoken to in
  ([ADR-0012](0012-agents-are-virtual-employees.md),
  [ADR-0021](0021-deterministic-first-side-channels-and-uncluttered-answers.md): natural answers).
- The user's own message is the most direct signal; a channel locale describes the client, not
  the conversation (an English Teams client, a German message).
- The shipped behaviour for German installations must not change for German users.
- The system prompt should stay stable per installation, so the prompt cache keeps one key.
- Detecting the language needs no extra model call: the answering model reads the message anyway
  (deterministic-first does not demand a classifier for a judgement the model makes in passing).

## Considered Options

- **A — Mirror the user's message; operator fallback language.** The prompt tells the model to
  answer in the language of the user's latest message; when that message shows none (a name, a
  number, a link, an emoji) it keeps the conversation's language, and without a conversation it
  uses the installation's `answer_language` setting (default German).
- **B — Operator setting only.** One fixed answer language per installation.
- **C — Channel locale first.** Answer in `ChatTurnInput.locale`, fall back to the setting.

## Decision Outcome

Chosen option: **A**, because it is what a person expects, needs no classifier and keeps the
German default for German users.

- **The rule lives in the kernel prompt** (`buildAnswerLanguageRule`,
  `harness-orchestrator/src/answerLanguage.ts`), fixed text per fallback language, so one
  installation has one system prompt as before.
- **Fallback setting** `answer_language` on `@omadia/orchestrator` (enum `de`, `en`, `fr`, `es`,
  `it`, `nl`, `pl`; default `de`), passed through `OrchestratorDeps.answerLanguage` like
  `answer_verbosity`. Unknown or empty values fall back to German.
- **`ChatTurnInput.locale` stays a hint** for what the kernel itself writes (notices, the
  AI-disclosure line). It never overrides the language the user wrote in.
- **Tool results, documents and the prompt's own language do not decide** the answer language.
- **Other model-written texts follow the same rule** where they speak to the user. Texts for the
  operator or for the model (summaries, extraction prompts) are out of this ADR's scope; the
  session summary follow-up (#1219, W13-14) applies the same rule to user-facing summaries.

### Consequences

- 🟢 **Good:** English (and other) speakers get answers in their language without asking.
- 🟢 **Good:** German installations behave as before for German messages; one setting covers
  installations with another main language.
- 🔴 **Bad:** The rule is a prompt instruction, so a model can still slip (e.g. after a long
  German tool result). Accepted: no deterministic check of the answer language is added.
- 🔴 **Bad:** The system prompt text changes once for every installation (one prompt-cache miss
  per installation after the deploy).
- ⚪ **Neutral:** Kernel notices keep following the channel locale; aligning them with the
  message language is a possible follow-up.

## Pros and Cons of the Options

### A — Mirror the user's message; operator fallback

- 🟢 Matches what the user did; no configuration needed in mixed-language teams.
- 🟢 No extra model call; stable prompt per installation.
- 🔴 Ambiguous one-word messages need the conversation and fallback rules.

### B — Operator setting only

- 🟢 Fully predictable.
- 🔴 Wrong for every user who does not speak the configured language — the reported bug.

### C — Channel locale first

- 🟢 Deterministic per turn.
- 🔴 Describes the client, not the message; missing in the web chat; would change the prompt per
  turn and split the prompt cache.

## More Information

- Issue #1992; prompt rule in `middleware/packages/harness-orchestrator/src/answerLanguage.ts`,
  setting in `middleware/packages/harness-orchestrator/manifest.yaml` (`answer_language`).
- Related: [ADR-0089](0089-ai-disclosure-in-the-outgoing-contract.md) (disclosure locale),
  [ADR-0021](0021-deterministic-first-side-channels-and-uncluttered-answers.md).
