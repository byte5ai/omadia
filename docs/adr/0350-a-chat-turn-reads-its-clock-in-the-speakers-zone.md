# 0350 — A chat turn reads its clock in the speaker's zone

## Status

Accepted

- **Date:** 2026-11-28
- **Deciders:** W50 cluster lead (wave 9, issue #2379; owner decision 2026-11-28: build it)
- **Supersedes:** in part [ADR-0340](0340-a-turn-is-grounded-in-its-frozen-start-time.md) (its
  statement "the zone stays the instance-wide `TURN_TIME_ZONE`")

## Context and Problem Statement

ADR-0340 froze a turn's date and start instant and named both in the date header, but always in
the instance zone `TURN_TIME_ZONE` (`Europe/Berlin`). A person in New York who asks at 22:30
"what's on tomorrow?" gets Berlin's 04:30 on the next day, named as such; "tomorrow" then lands
one day off. Triggers already run in the person's zone (ADR-0297: `userTimeZone`, else the
instance default), so a reminder set in the same chat used a different clock than the answer
that confirmed it. Which zone does a chat turn read its date and clock time in, and which
person's zone counts in a group chat?

## Decision Drivers

- Relative time ("tomorrow", "this afternoon", "in two hours") means the speaker's clock.
- One source of truth for "the person's zone": the same one triggers and routines use
  (ADR-0240, ADR-0297).
- One turn speaks one "now" in one zone across every model call (ADR-0340).
- No cached prompt block may carry a value that changes per turn or per person (ADR-0077).
- A wrong, missing or hostile zone value must never break a turn.

## Considered Options

- **A — The speaker's zone from the turn input, validated, frozen with the clock; else
  `TURN_TIME_ZONE`.**
- **B — A per-person zone setting stored in the user profile.**
- **C — Keep the instance zone (ADR-0340 as is).**

## Decision Outcome

Chosen option: **A**.

- **Source.** `ChatTurnInput.userTimeZone`, the field triggers and `manage_routine` already
  read (ADR-0240, ADR-0297). Channel adapters fill it where their platform reports a zone: Teams
  sends the Bot Framework client's `localTimezone` (else `Europe/Berlin`); Telegram currently
  sends a fixed `Europe/Berlin`; Discord, Slack and WhatsApp send none and stay on the instance
  zone. The web chat fills it from the browser's zone, which the web UI
  already mirrors into the `omadia-tz` cookie (`web-ui/app/_lib/timeZone.ts`, #1091); the
  same-origin `/bot-api` proxy forwards the cookie and `routes/chat.ts` (`webTurnTimeZone`)
  passes it on when it is a valid zone. The value is the sender's own clock; it grants nothing.
- **Resolution.** `resolveTurnTimeZone(candidate)` (`harness-orchestrator/src/turnContext.ts`)
  keeps a candidate only when it is a string of at most 64 IANA-shaped characters that `Intl`
  can format in; anything else (absent, unknown, malformed) falls back to `TURN_TIME_ZONE`,
  never thrown on, never guessed.
- **Frozen once.** `turnClock(at, zone)` returns `turnDate`, `turnStartedAt` and
  `turnTimeZone` from one reading; the date is the date in that zone. The orchestrator's `chat`
  and `chatStream` scopes and a CLI turn freeze it from `input.userTimeZone`; a CLI sub-agent
  inside a parent turn keeps the parent's clock and zone. Sub-scopes that copy the context
  explicitly (`runWithChatParticipants`, skill-bound tool calls, plugin `ctx.mcp` calls) carry
  `turnTimeZone` along. A consultation hands the asker's `userTimeZone` to the colleague's
  turn, which freezes its own clock in the same person's zone.
- **The header** names the frozen zone and its offset: `Current date and time: Friday,
  2026-11-27, 22:30 (America/New_York, GMT-05:00), taken at the start of this turn.` It stays
  in the uncached date block (in-process) and the leading `System Hint:` of the CLI stdin prompt;
  no cached block carries the time or the zone (ADR-0077, ADR-0340).
- **Group and channel turns.** The zone is the one of the person whose message triggered the
  turn. Reasons: the turn answers that person's message, so their relative expressions are the
  ones to resolve; a trigger or routine that turn creates already uses that person's zone
  (ADR-0297), and the answer confirming it must use the same clock; a single frozen zone keeps
  one "now" per turn, where a list of everyone's zones would make "tomorrow" ambiguous; and the
  header names the zone, so a reader in another zone sees which clock was meant. When the
  channel reports no zone for the speaker, the instance zone applies, as before.
- **Turn-less fallbacks** (a plugin `ctx.mcp` call at activate time, a consultation without a
  parent turn) date themselves with `today()` in `TURN_TIME_ZONE`, never with a UTC date.

### Consequences

- 🟢 **Good:** "tomorrow", "this afternoon" and "what time is it" follow the speaker's clock,
  the same clock their triggers and routines run on.
- 🟢 **Good:** no new setting, store or UI: the zone comes from where channels and the browser
  already report it.
- 🟢 **Good:** a bad zone value cannot fail a turn; it is named as the instance zone instead.
- 🔴 **Bad:** in a group chat, other members read an answer grounded in the speaker's clock.
  Accepted: the header names the zone, and the triggering person is the one being answered.
- 🔴 **Bad:** the zone is coarse location data and now reaches the model on every turn that has
  one. Accepted: it sits only in the per-turn, uncached date block, and the trigger tools already
  name it (ADR-0297).
- 🔴 **Bad:** on the web chat (browser zone) and on Teams streaming turns (client
  `localTimezone`) the person's zone now also sets the default zone of routines and triggers
  created in chat (they read the same `userTimeZone`), where they used the instance default
  before. Intended: that is ADR-0240's "the creator's zone".
- ⚪ **Neutral:** routine runs and trigger firings are unchanged: their turn input names no
  `userTimeZone`, so their header stays in `TURN_TIME_ZONE`, and their own hint keeps the
  routine's zone (ADR-0242).
- ⚪ **Neutral:** channels that report no zone gain nothing until their adapter sends one.
- ⚪ **Neutral:** the streaming path now also carries `userTimeZone` into the turn scope (it only
  did on `chat`), so `manage_routine` and the trigger tools see it on channel and web turns.

## Pros and Cons of the Options

### A — Speaker's zone from the turn input

- 🟢 Reuses the triggers' source; no new contract.
- 🔴 Depends on the channel reporting a zone; without one nothing changes.

### B — Stored per-person setting

- 🟢 Works on channels that report no zone.
- 🔴 Needs a store, a settings UI and a precedence rule against what the channel reports.
  Channels without a zone (Discord, Slack, WhatsApp, Telegram's fixed value) are the case for
  it; it stays a possible follow-up on top of A, which it would only feed.

### C — Instance zone

- 🟢 No change.
- 🔴 The reported gap stays; answers and the triggers they confirm disagree on the clock.

## More Information

- Issue [#2379](https://github.com/byte5ai/omadia/issues/2379); follow-up of #2376.
- ADR-0077 (uncached date block), ADR-0240 (routine zones), ADR-0242 (unattended turns),
  ADR-0297 (trigger zone), ADR-0340 (frozen start time).
- Code: `resolveTurnTimeZone`, `isTurnTimeZone`, `turnClock`, `buildDateHeader`,
  `turnContext.currentTurnTimeZone` in `middleware/packages/harness-orchestrator/src/turnContext.ts`;
  `webTurnTimeZone` in `middleware/src/routes/chat.ts`. Tests
  `middleware/test/orchestrator/turnTimeZone2379.test.ts`,
  `middleware/test/turnDateFallback2379.test.ts`.
