# 0243 — Routine cost is shown per run and on the routine's trigger

## Status

Proposed

- **Date:** 2026-11-26
- **Deciders:** omadia maintainers (wave 5, W22-23; owner question of #1776 decided after
  recommendation, reversible)
- **Supersedes:** —

## Context and Problem Statement

Routine runs write usage rows like chat turns (`source = orchestrator`, plugin sources),
so routine cost is mixed into the chat rows of `/admin/usage` and no routine page shows
what a run or a routine costs (#1776). Cron runs already settle their cost on the
routine's trigger (ADR [0020](0020-proactive-agents-with-bounded-triggers.md): operators
see every trigger with its cost); a manual "run now" did not. Where does routine cost
become visible?

## Decision Drivers

- ADR 0020: trigger cost is visible on the operator trigger view; routines are triggers.
- ADR [0088](0088-usage-ledger-in-usd-with-read-time-price-resolution.md): the usage ledger
  stays one table; its sources describe the producing component.
- The routine's owner and the operator want "what did this run / this routine cost".

## Considered Options

- **A — a "Routines" source on `/admin/usage`**
- **B — cost per run in the run history and a total per routine, plus manual runs booked
  on the routine's trigger**
- **C — A and B**
- **D — no change**

## Decision Outcome

Chosen option: **B**.

- Every run measures its model cost with the cost meter around the turn and the emitter's
  guard, also when the turn throws, and stores it in `routine_runs.cost_usd` (routines
  migration `0011`). `GET /api/v1/routines/:id/runs` returns `costUsd` per run and
  `totalCostUsd` for the routine.
- A manual run's cost is booked on the routine's trigger (`TriggerService.bookManualSpend`:
  spend, monthly instance and agent spend, an audit row `fired` with
  `outcome: manual_run`), without counting a run or touching the breaker. A cron run's cost
  is settled by its firing, as before. So the operator trigger view and the monthly trigger
  budgets include every run of a routine.
- `/admin/usage` stays as it is; its sources are not split by session.

### Consequences

- 🟢 **Good:** the cost of a routine and of each run is visible where the routine is managed.
- 🟢 **Good:** manual runs count towards the trigger and monthly budgets like cron runs.
- 🔴 **Bad:** the usage dashboard still books routine runs under the chat sources; the
  operator sees the routine share only on the routine and trigger views.
- ⚪ **Neutral:** option A can still be added later; the run rows carry what it would need.

## Pros and Cons of the Options

### A — usage source

- 🟢 One place for all cost.
- 🔴 Splits ledger sources by session scope, a second classification next to `source`.

### B — per run and on the trigger

- 🟢 Uses the cost meter and the trigger spend that exist; no ledger change.
- 🔴 Not in the dashboard.

### D — no change

- 🔴 More than half of a test instance's spend stayed invisible.

## More Information

Issue #1776.
