# 0240 — Recurring schedules run in a named time zone

## Status

Proposed

- **Date:** 2026-11-26
- **Deciders:** omadia maintainers (wave 5, W22-23; decision after recommendation, reversible)
- **Supersedes:** —

## Context and Problem Statement

A cron pattern says "09:00", but a routine's trigger was created without a zone, so croner
evaluated it in the process zone (UTC in every container), and the Conductor's minute poll
matched schedules against UTC parts while `conductor_schedules.timezone` was stored and
ignored (#1743, #1714). No surface named the zone, `manage_routine` accepted patterns that
never fire, fire once, or mean something other than they look (`@daily`, `5L`, `?`), and the
trigger engine refused some of them only later, when it scheduled the routine (#1750). How
do recurring schedules know their zone, and where is a pattern checked?

## Decision Drivers

- "Täglich um 09:00" must fire at 09:00 for the person who asked, across DST.
- One rule for every scheduler (routines, agent `wake_every`, Conductor), not one per caller.
- A pattern is refused when it is created, with a reason the model and the user can read.
- Stored patterns keep their meaning (no silent re-interpretation of existing rows).

## Considered Options

- **A — every recurring schedule stores an IANA zone; one helper evaluates and checks it**
- **B — keep UTC everywhere and label every surface "UTC"**
- **C — evaluate in the instance zone (`PROACTIVE_TIMEZONE`) without storing one**

## Decision Outcome

Chosen option: **A**.

- `middleware/src/scheduler/zonedCron.ts` is the one place that answers when a pattern fires
  and in which zone: `nextCronRun(s)` (croner with `timezone`), `cronMatchesInZone` (the
  minimal matcher of `cron.ts` on the zone's wall clock, for the Conductor's minute poll),
  `zonedCalendarParts`, `formatInTimeZone`, `isValidTimeZone`, `resolveTimeZone`.
- **The zone is stored with the schedule.** A routine stores `routines.timezone`, resolved
  at creation from the creator's zone when the channel knows it, else `PROACTIVE_TIMEZONE`,
  else UTC (`resolveTimeZone`); its trigger gets the same zone. A Conductor schedule
  evaluates its stored `timezone`. A row without a zone keeps UTC, its old meaning.
- **`checkCronSchedule` runs before a recurring schedule is stored**, synchronously, and
  refuses with a typed code: unknown zone, `?` in the pattern, anything but a plain 5-field
  pattern of digits, `*`, `,`, `-`, `/` (no `@daily`, no `L`/`W`/`#`: the trigger engine
  validates with the minimal matcher, and `parseInt('5L')` reads "last Friday" as Friday),
  fewer than two upcoming runs, and a shortest gap below the minimum interval. On success it
  returns the next run, which the creating surface names with its zone.
- Every surface that shows a schedule names its zone (tool result, routines page).

### Consequences

- 🟢 **Good:** a routine fires at the wall-clock time its creator meant, in summer and winter.
- 🟢 **Good:** a refused pattern is refused at creation with a reason, never paused later.
- 🔴 **Bad:** patterns croner accepts but the minimal matcher does not (`@daily`, names like
  `MON`, Quartz extensions) are no longer accepted for new routines; the model has to spell
  them as numbers.
- 🔴 **Bad:** a zone is only as good as its source: channels that do not report the user's
  zone give the instance default, which is wrong for a user abroad until the zone is editable.
- ⚪ **Neutral:** existing rows keep UTC; a migration to the creator's zone is not attempted,
  because the creator's zone at creation is unknown.

## Pros and Cons of the Options

### A — stored zone, one helper

- 🟢 Correct across DST; one implementation for three schedulers.
- 🔴 A column per schedule table and a zone source per channel.

### B — UTC everywhere, labelled

- 🟢 No schema change.
- 🔴 Every user converts by hand, twice a year differently.

### C — instance zone, not stored

- 🟢 Right for a single-zone team.
- 🔴 Changing `PROACTIVE_TIMEZONE` silently moves every existing schedule.

## More Information

- Issues #1743 (routines), #1750 (pattern checks), #1714 (Conductor schedules).
- ADR [0020](0020-proactive-agents-with-bounded-triggers.md): routines are user-requested
  triggers and keep their cron semantics; triggers already carried an optional `timezone`.
- `middleware/src/scheduler/cronerCompat.ts`: the legacy `?` meaning for stored rows stays.
