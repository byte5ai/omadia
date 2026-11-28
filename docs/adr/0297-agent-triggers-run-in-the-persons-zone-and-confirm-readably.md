# 0297 — Agent triggers run in the person's zone and confirm themselves readably

## Status

Accepted

- **Date:** 2026-11-27
- **Deciders:** omadia maintainers (wave 6, W34)
- **Supersedes:** [ADR-0241](0241-field-level-interning-exemption-for-kernel-state-tools.md) in part ("`manage_routine` is the only entry")

## Context and Problem Statement

The W37 live test (#2339) set a one-minute `wake_at` whose `post` template said "current
time: {{now}}". At 11:47 in Berlin it posted 10:47: a trigger without its own zone renders and
schedules in UTC, while routines created in the same chat already run in the creator's zone
(ADR-0240). The tool answer also reached the model as a privacy-shield digest, so the agent
could not confirm when the trigger fires. Which zone does an agent trigger use when the model
names none, and what of the trigger's answer may the model read?

## Decision Drivers

- `{{now}}`, `{{until}}` and a cron mean what the person reads on their clock.
- The agent must confirm the trigger it set (id, when it fires) to the person.
- Text the model wrote on restored input, or that may quote a failed tool, stays interned.
- A model-named zone keeps priority.

## Considered Options

- **A — The person's zone as the default, and an ADR-0241 field exemption for the trigger tools**
- **B — The model must always pass `timezone`; trigger answers stay interned**
- **C — Exempt the trigger tools as a whole (`INTERN_EXEMPT_TOOLS`)**

## Decision Outcome

Chosen option: **A**.

- `TriggerEnvelope.timezone` carries the zone of the creating turn: `userTimeZone`, else
  `PROACTIVE_TIMEZONE` (`resolveTimeZone`, set in `wiring.ts`). The policy uses it when the
  request names no `timezone`; for `wake_every` a named zone still wins. Triggers created by
  the kernel (routines, schedules, batch jobs) keep the zone they pass themselves.
- The trigger tools' summary names `timezone` always and `atLocal` for a one-shot (the firing
  time in that zone).
- `on_event`, `wake_at`, `wake_every`, `list_triggers` and `cancel_trigger` join
  `INTERN_FIELD_EXEMPT_TOOLS`, withholding `purpose`, `lastOutcome`, `pausedBecause` and
  `label`. The tools still run on restored input; `isPubliclyServableTool` keeps refusing them.

### Consequences

- 🟢 **Good:** "remind me in a minute with the time" posts the person's clock time.
- 🟢 **Good:** the agent confirms id and firing time ("fires at 11:48") instead of guessing.
- 🔴 **Bad:** a `wake_every` cron the model wrote without a zone now runs in the person's zone,
  not UTC; existing triggers keep their stored zone (NULL = UTC).
- 🔴 **Bad:** the model cannot read back a trigger's purpose through `list_triggers`; it names
  triggers by kind, time and id.
- 🔴 **Bad:** a `wake_at.time` or `until` written as a date-time without an offset is still
  read in the server's zone, not the person's; the tool answer's `atLocal` shows the result,
  and the tool description keeps preferring durations.
- ⚪ **Neutral:** another kernel tool still needs its own reviewed entry in the map.

## Pros and Cons of the Options

### A — Default zone and field exemption

- 🟢 Matches routines (ADR-0240) and keeps free text interned (ADR-0241's rule).
- 🔴 Two lists name the trigger tools (`triggerTools.ts`, `privacyInternPolicy.ts`); a test
  pins them equal.

### B — Model passes the zone, answers stay interned

- 🟢 No change to the privacy map.
- 🔴 The model does not know the person's zone reliably, and still cannot confirm the trigger.

### C — Exempt as a whole

- 🟢 Simplest.
- 🔴 Hands the purpose written on restored input (real names) to the model in clear.

## More Information

#2339. `middleware/src/triggers/{triggerPolicy,triggerTools,wiring}.ts`,
`middleware/packages/harness-orchestrator/src/privacyInternPolicy.ts`. The issue's third
point, `manage_routine` `run_now`, needs no own decision: it is a manual run like the trigger
route's and an unattended turn under ADR-0242 (started detached from the asking turn). Related:
[ADR-0240](0240-schedules-run-in-a-named-time-zone.md),
[ADR-0241](0241-field-level-interning-exemption-for-kernel-state-tools.md).
