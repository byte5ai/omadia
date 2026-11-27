# 0250 — Conductor schedules retain their own time zone

## Status

Accepted

- **Date:** 2026-11-26
- **Deciders:** omadia maintainers, Wave 5 Conductor (#1714)
- **Extends:** [ADR-0240](0240-schedules-run-in-a-named-time-zone.md)

## Context and Problem Statement

Conductor stored a time zone per schedule but evaluated every pattern in UTC. Republishing a workflow replaced its schedule rows and discarded their stored zones.

## Decision Drivers

- Keep the existing UTC meaning for new schedules and old default rows.
- Preserve a schedule's stored zone when the workflow is republished with the same expression.

## Considered Options

- **A — Evaluate each persisted zone with the shared cron matcher**
- **B — Keep UTC and remove the per-schedule setting**

## Decision Outcome

Chosen option **A**. The poller evaluates the plain five-field expression against wall time in the row's IANA zone using `cronMatchesInZone`. The database claims absolute minutes. A civil minute that DST skips cannot match. If a civil minute occurs twice, each absolute minute can match. An unknown zone is logged and the schedule is skipped.

Reconciling the same expression keeps the row, its zone and its cursors. A new expression starts in UTC. The designer reads the published zones, and the run history shows the zone recorded at dispatch.

### Consequences

- An instance time-zone change does not move existing schedules.
- Authors see UTC for a new expression until zone selection is added to the designer.

## More Information

`scheduleStore.ts`, `scheduleWorker.ts`, `scheduler/zonedCron.ts`.
