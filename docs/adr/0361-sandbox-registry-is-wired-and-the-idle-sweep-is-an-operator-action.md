# 0361 — The sandbox registry is wired; the idle sweep is an operator action

## Status

Proposed

- **Date:** 2026-11-28
- **Deciders:** W52 cluster lead (wave 9, issue #2320; decision after the recommendation,
  reversible)
- **Supersedes:** in part [ADR-0055](0055-agent-computer-is-a-docker-sandbox-per-scope.md) (its
  consequence "plugin.ts passes no registry and schedules no reaper")

## Context and Problem Statement

ADR-0055 records that `PostgresSandboxRegistry` and `reapOrphanedSandboxes` exist but are not
used: containers of finished scopes stay until someone removes them by hand, and nothing
lists them. #2320 asks for a sandbox admin view with reaper control. Should the registry be
wired, should the reaper run on a schedule, and what may an operator remove?

## Decision Drivers

- An operator must see which scope containers exist and when they were last used.
- Removing a sandbox deletes its files; a `persistent` sandbox exists to keep them.
- No surprise deletions on an instance that never chose a threshold.
- The registry and the agent's process-local cache must not disagree in a way that breaks
  the next command.

## Considered Options

- **A — Wire the registry when the graph pool exists; the sweep runs only when an operator
  starts it, with a threshold they choose; an operator may remove any single sandbox.**
- **B — Wire the registry and schedule the reaper with a default threshold.**
- **C — Keep the registry unwired; list containers from Docker instead.**

## Decision Outcome

Chosen option: **A**.

- **Wiring.** `harness-orchestrator/src/plugin.ts` passes one `PostgresSandboxRegistry` to the
  Docker backends of `execute` and `publish` when the graph pool exists; without a pool,
  nothing changes.
- **Sweep.** `POST /api/v1/admin/sandboxes/reap` with `idleMinutes` (5 minutes to 30 days) and
  an optional dry run. Non-persistent sandboxes idle longer than that are removed through
  `reapOrphanedSandboxes`; `persistent` ones never. No sweep runs on a schedule.
- **Single teardown.** `POST /teardown { scopeKey }` removes one sandbox, persistent or not —
  an explicit operator decision, confirmed twice in the UI. `docker rm -f` only for a ref
  that matches Docker's container-name charset; a container Docker does not know counts as
  removed; any other failure keeps the row.
- **Cache.** `DockerSandboxBackend.provision` drops a cached handle whose registry row is gone
  and provisions again. A failed registry read keeps the cached handle (an outage must not
  break a running container).
- **Audit.** `sandbox.reap` and `sandbox.teardown` rows (ADR-0100), scope keys only.

### Consequences

- 🟢 **Good:** Idle containers are visible and removable without shell access to the host.
- 🟢 **Good:** No instance loses sandbox files without an operator choosing a threshold.
- 🔴 **Bad:** Without an operator, idle containers still accumulate.
- 🔴 **Bad:** A teardown that races a `provision` of the same scope in another process can
  leave a row for a removed container (or a container without a row); the next uncached
  provision repairs the first case, a later sweep the second.
- 🔴 **Bad:** An operator can remove a persistent sandbox and its files.
- ⚪ **Neutral:** A scheduled reaper can be added later behind an opt-in setting.

## Pros and Cons of the Options

### A — Wired registry, manual sweep

- 🟢 Visibility and control with no new default behaviour.
- 🔴 Cleanup depends on someone using it.

### B — Scheduled reaper

- 🟢 Containers do not accumulate.
- 🔴 A default threshold deletes files on instances that never agreed to it.

### C — List from Docker

- 🟢 No database dependency.
- 🔴 No last-use time, so no idle rule; and the kernel would need Docker even to read.

## More Information

- Code: `middleware/src/routes/adminSandboxes.ts`,
  `middleware/packages/harness-sandbox/src/dockerSandbox.ts`,
  `middleware/packages/harness-orchestrator/src/plugin.ts`, `web-ui/app/admin/sandboxes/`.
- Tests: `middleware/test/adminSandboxesRoute.test.ts`,
  `middleware/test/sandbox/dockerSandboxRegistry.test.ts`.
- Related: [ADR-0055](0055-agent-computer-is-a-docker-sandbox-per-scope.md),
  [ADR-0067](0067-published-apps-are-immutable-versions-behind-their-own-origin.md),
  [ADR-0100](0100-admin-audit-trail-one-actor-rule.md).
