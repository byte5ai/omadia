# 0340 — A turn is grounded in its frozen start time, not only its date

## Status

Accepted — superseded in part by [ADR-0350](0350-a-chat-turn-reads-its-clock-in-the-speakers-zone.md) (a chat turn reads its clock in the speaker's zone when known)

- **Date:** 2026-11-27
- **Deciders:** W46 cluster lead (wave 8 follow-up, issue #2376; decision after the
  recommendation, reversible)
- **Supersedes:** in part [ADR-0242](0242-unattended-turns-for-routines-and-triggers.md) (its
  statement "the turn context carries only the date")

## Context and Problem Statement

A chat turn was told the date but not the time. `buildDateHeader`
(`harness-orchestrator/src/turnContext.ts`) wrote a German line "Heute ist <weekday>, der <date>
(Europa/Berlin)", fed from the frozen `turnDate`. Asked "What time is it?", the web chat answered
that it does not know the clock time, while a routine run knows it, because `routineRunner.ts` puts
`Current time: …` into its own hint (ADR-0240, ADR-0242). The CLI path (subscription `claude`)
was told neither. What does a turn know about "now", and how does it stay the same across every
model call of the turn?

## Decision Drivers

- Relative time ("in two hours", "this afternoon", "is the shop still open?") needs the clock
  time, not only the date.
- One turn must speak one "now": the orchestrator loop, local sub-agents and CLI sub-agents run
  several model calls, possibly across midnight.
- The prompt cache (ADR-0077): a value that changes every turn must not sit in a cached block.
- Language (ADR-0220, ADR-0332): the answer follows the user; the header is model-facing text.

## Considered Options

- **A — Freeze the start instant next to the date; the date header names time and zone.**
- **B — Read the clock fresh at every model call.**
- **C — Leave chat turns without the time; only routines get it.**

## Decision Outcome

Chosen option: **A**.

- **One reading.** `turnClock(at = new Date())` returns `turnDate` and `turnStartedAt` (ISO 8601,
  UTC) from the same instant. Turn entry points spread it into the scope they open: the
  orchestrator's `chat` and `chatStream` scopes, and a CLI turn (`CliChatAgent.beginDiscretion`)
  unless a calling turn already froze one (a CLI sub-agent inside a parent turn keeps the
  parent's clock). Sub-scopes that copy the context explicitly (`runWithChatParticipants`,
  skill-bound tool calls, plugin `ctx.mcp` calls) carry `turnStartedAt` along.
- **The header.** `buildDateHeader(date, startedAt?)` names weekday, date, `HH:mm` (24 h), the zone
  and its UTC offset: `Current date and time: Friday, 2026-11-27, 14:05 (Europe/Berlin,
  GMT+01:00), taken at the start of this turn.` `turnContext.currentDateHeader()` builds it from
  the active scope. Outside a turn it reads "now" once. A scope opened with a frozen `turnDate`
  but without `turnStartedAt` gets the date-only header, never its frozen date next to a live
  clock. The Builder turns (`builderAgent.ts`, `previewChatService.ts`) open their scope with
  `turnClock()` too. A consultation (`consultationBroker.ts`) copies only the date on purpose:
  the consulted agent's turn freezes its own clock. The zone stays the instance-wide `TURN_TIME_ZONE` (`Europe/Berlin`), as before; the
  header only names it.
- **Where it goes.** In-process: the orchestrator's own uncached date block and the uncached second
  system block of a local sub-agent, as before (ADR-0077). No cached block carries the time. CLI:
  a leading `System Hint:` line of the stdin prompt, not the `--system-prompt`, so the CLI's
  system prompt stays the same across turns.
- **English.** The header is model-facing text, which ADR-0220 leaves out of its scope. The answer
  language follows the user through the kernel's answer-language rule, not through this block. The
  CLI prompt's other kernel hints are English already.

### Consequences

- 🟢 **Good:** chat turns answer "what time is it" and resolve "in two hours" against the turn's
  real start, the same on API and CLI turns.
- 🟢 **Good:** every model call of one turn (tool loop, sub-agents, retries) sees the same header;
  a turn that starts at 23:59 never pairs one day's date with the next day's time.
- 🟢 **Good:** no extra cache misses: the block was per-turn and uncached already.
- 🔴 **Bad:** the time is the turn's start. A long turn (minutes of tools) still says the start
  time. Accepted: the header says "taken at the start of this turn".
- 🔴 **Bad:** the zone is the instance's, not the person's. A user in another zone gets Berlin time,
  named as such. A per-person zone (as triggers use, ADR-0297) is a possible follow-up.
- ⚪ **Neutral:** the header text changed from German to English once for every installation.

## Pros and Cons of the Options

### A — Freeze the start instant

- 🟢 One value per turn; consistent across model calls and sub-agents.
- 🔴 Every scope that copies the context explicitly has to carry one more field.

### B — Fresh clock per model call

- 🟢 Always the current minute.
- 🔴 Two calls of one turn can disagree (and across midnight even on the date); breaks the frozen
  date's purpose.

### C — Routines only

- 🟢 No change.
- 🔴 The reported gap stays: a chat turn cannot tell the time.

## More Information

- Issue [#2376](https://github.com/byte5ai/omadia/issues/2376).
- ADR-0077 (date header is its own uncached system block), ADR-0240 (named time zones for
  schedules), ADR-0242 (routine runs are told the current time), ADR-0220 / ADR-0332 (language).
- Code: `turnClock`, `buildDateHeader`, `turnContext.currentDateHeader` in
  `middleware/packages/harness-orchestrator/src/turnContext.ts`; tests
  `middleware/test/orchestrator/turnClock2376.test.ts`,
  `middleware/test/cliBridge/cliChatAgent.test.ts` (#2376 cases).
