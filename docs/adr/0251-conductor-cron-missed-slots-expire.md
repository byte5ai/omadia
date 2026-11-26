# 0251 — Conductor cron slots expire after their minute

## Status

Proposed

- **Date:** 2026-11-26
- **Deciders:** omadia maintainers, Wave 5 Conductor (#1715)

## Context and Problem Statement

Spec 005 FR-009 requires a record when a trigger is suppressed. Before the change, matching disabled workflows and downtime gaps left no record.

## Decision Drivers

- Avoid replaying potentially state-changing workflow actions after a long outage.
- Keep per-slot claims safe across replicas and preserve the durable run resume path.

## Considered Options

- **A — Expire missed start slots and log suppression**
- **B — Catch up one or more missed slots on restart**

## Decision Outcome

Chosen option **A**. Only the current absolute minute can start a cron run. Each schedule has a durable inspection cursor. The next poll after a gap logs a count of matching slots in the most recent 24 hours and the length of any earlier uninspected window. This bound keeps restart work proportional to the number of schedules. An on-time slot due for a disabled workflow or schedule is logged once by the poll winner.

Matching disabled event subscribers appear in `POST /conductors/emit` under `suppressed`; the existing enabled-match count and addressed-bot `skippedWorkflows` keep their meanings. The runtime resume rules for runs that already started are unchanged.

### Consequences

- Operators can see the time interval that expired and whether older minutes were outside the counting window.
- If the process exits after claiming a minute but before logging or starting a run, that minute is not retried. A run already persisted remains eligible for resume.

## More Information

Spec 005 FR-009, [ADR-0128](0128-conductor-durable-runs-lease-fencing-and-reconcile.md), `scheduleWorker.ts`, `eventRouter.ts`.
