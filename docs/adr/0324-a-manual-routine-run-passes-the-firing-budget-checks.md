# 0324 — A manual routine run passes the budget checks of a scheduled firing first

## Status

Accepted

- **Date:** 2026-11-27
- **Deciders:** omadia maintainers (wave 7, W43; #2357; decision after recommendation, reversible)
- **Supersedes:** —

## Context and Problem Statement

A scheduled routine run is a firing of the routine's trigger. Before it spends anything, the
trigger engine checks the kill switch and reserves the per-firing budget against the trigger's
total and against the agent's and the instance's monthly caps; a firing that does not fit is
refused and the trigger pauses for budget
([ADR-0020](0020-proactive-agents-with-bounded-triggers.md)). A manual run — `manage_routine`
`run_now`, the routine page's "run now", the smart-card button — started without any of these
checks. Its cost is booked on the trigger afterwards
([ADR-0243](0243-routine-cost-per-run-and-on-its-trigger.md)), so a routine whose budget was used up
could still be run by hand without limit (#2357, follow-up of #2344). What does a manual run check
first?

## Decision Drivers

- The caps must hold for every run of a routine, not only the scheduled ones.
- A manual run must not pause the schedule or be counted as a firing.
- One rule, in the trigger service, for every manual entry point.

## Considered Options

- **A — A read-only pre-check with the firing's rules; cost booked afterwards as before**
- **B — Reserve the per-firing budget for a manual run like a firing and settle it afterwards**
- **C — Keep manual runs outside the budgets**

## Decision Outcome

Chosen option: **A**.

- `TriggerService.manualRunRefusal(kind, contextId)` refuses when the agent's or instance's kill
  switch is set, when the trigger is paused for budget, or when one more firing's
  `budget_per_firing_usd` would exceed the trigger's total or the agent's or instance's month. It
  writes nothing. Without a trigger (no trigger engine for the routine) there is nothing to check.
- `RoutineRunner` calls it through `manualRunRefusal` before `startManualRun` (`run_now`, answered
  at once) and `triggerRoutineNow` (smart card) take the run slot; the routine route
  (`POST /api/v1/routines/:id/trigger`) asks before its `202` and answers `409
  routines.budget_refused` with the reason. `manage_routine` passes the reason to the model; the
  card says it in its own text.
- A failing pre-check (database error) is logged and lets the run start: the caps of scheduled
  runs stay enforced by the firing's own reservation.

### Consequences

- 🟢 **Good:** a routine over its budget, or under a kill switch, cannot be run by hand.
- 🟢 **Good:** no schedule pause, no reservation and no firing record for a manual run.
- 🔴 **Bad:** check and booking are not atomic; two manual runs (of different routines) checked at
  the same moment can together overshoot a month by one firing's budget.
- 🔴 **Bad:** a manual run's actual cost may exceed `budget_per_firing_usd`; the check reserves
  only that amount's room, as a firing's reservation does.

## Pros and Cons of the Options

### A — read-only pre-check

- 🟢 Small; uses the firing's numbers and the existing after-the-fact booking.
- 🔴 Not atomic (see consequences).

### B — reserve like a firing

- 🟢 Atomic with the caps.
- 🔴 A reservation needs an occurrence to settle against; a manual run has none, and a crash
  would leave reserved money stuck.

### C — no checks

- 🔴 The reported gap: budgets that do not hold.

## More Information

Issue #2357; `middleware/src/triggers/triggerService.ts` (`manualRunRefusal`),
`middleware/src/plugins/routines/{routineRunner,manageRoutineTool,integration}.ts`,
`middleware/src/routes/routines.ts`; tests `middleware/test/routineManualRunBudget.test.ts`,
`routineRunner.test.ts`, `manageRoutineTool.test.ts`, `routinesTriggerRoute.test.ts`.
