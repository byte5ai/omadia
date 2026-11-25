# 0129 — Agent-started workflows come only from curated patterns, with a TTL and quotas

## Status

Accepted

- **Date:** 2026-11-25
- **Deciders:** omadia maintainers; #330 Workstream A (#818), restart-proof run state (#841,
  migration 0012), per-caller capability (epic #470 §2.2), operator view #2067 (recorded
  retroactively from the code on main)

## Context and Problem Statement

Some processes are created at run time by an agent or a plugin rather than designed by an
operator: an agent topic discussion, originally also the facilitation tick. Letting a model
submit a workflow graph would put generated control flow into the deterministic engine and
let a loop create runs without end. How may code other than an operator create and start a
workflow? This record is retroactive.

## Decision Drivers

- Generated workflows must stay validatable by the same engine as authored ones.
- Runaway creation must be structurally impossible, not a matter of prompt discipline.
- Operator-authored workflows and generated ones must not collide or clutter the library.
- The run history is an audit trace and must outlive the definition.
- A plugin must not read or change another caller's runs.

## Considered Options

- **A — Instantiate a bundled pattern by filling slots; mandatory clamped TTL; per-agent
  concurrency and rate limits; a reaper**
- **B — Accept arbitrary graphs from agents, validated with `validate()`**
- **C — No generated workflows; operators pre-create every process**

## Decision Outcome

Chosen option: **A**.

- **A pattern is a `TemplateManifest`** in its own, smaller catalog
  (`middleware/src/conductor/patterns/`, today `discussion.json`). `createEphemeralRun` may
  only instantiate what ships there, never user- or plugin-contributed templates. The caller
  fills slots and a context payload; the kernel owns the graph.
- **Create and start are one call.** The result is a workflow with origin `ephemeral` and a
  slug under the reserved prefix `eph-`; the manual create and instantiate routes refuse
  that prefix. Ephemeral workflows never appear in the library.
- **Guardrails, env-tunable:** TTL default 24 h (`CONDUCTOR_EPHEMERAL_DEFAULT_TTL_MS`),
  clamped to at most 7 days (`CONDUCTOR_EPHEMERAL_MAX_TTL_MS`); at most 3 active per agent
  (`CONDUCTOR_EPHEMERAL_MAX_ACTIVE_PER_AGENT`); at most 10 creations per hour
  (`CONDUCTOR_EPHEMERAL_MAX_CREATES_PER_HOUR`).
- **The reaper** (every 60 s, `CONDUCTOR_EPHEMERAL_REAPER_INTERVAL_MS`) first requests
  cancellation of an expired workflow's active runs, honoured at the next step boundary,
  then reaps the definition logically (disabled plus `reaped_at`). A physical delete happens
  only for rows no run references; `conductor_runs.workflow_version_id` is `RESTRICT`.
- **Owner-scoped state for restarts.** `listOwnRuns` and `saveRunState` let a creator read
  back its active runs with their start payload and a size-capped state blob. The owner
  filter is in the SQL (`created_by_agent`); a write to a foreign, terminal or reaped run
  updates nothing.
- **`conductorEphemeralRuns` is a per-caller service.** The owner-scoped methods compare
  the supplied `agentId` with the plugin id the kernel activated the caller under, and
  answer a mismatch like an unknown run. `createEphemeralRun` and `poke` stay pass-through;
  a mismatch is logged.
- **Ephemeral attachments** bind one conversation to one such workflow and are released by
  the reap.

### Consequences

- 🟢 **Good:** Generated workflows are engine-checked graphs; an agent cannot invent control
  flow.
- 🟢 **Good:** Creation is bounded per agent and every definition expires.
- 🔴 **Bad:** A new kind of generated process needs a kernel release that ships its pattern.
- 🔴 **Bad:** A run still inside a step when its TTL passes ends only at the next step
  boundary.
- 🔴 **Bad:** A plugin can still spend creation quota under another agent's id through the
  pass-through `createEphemeralRun`; only logging catches it.
- ⚪ **Neutral:** Facilitations no longer run as ephemeral workflows; they are processes of
  the facilitator plugin under execution scopes
  ([ADR-0022](0022-native-facilitators-as-an-archetype-plugin.md)). The mechanism stays for
  discussions.

## Pros and Cons of the Options

### A — Curated patterns with TTL and quotas

- 🟢 Generative and governed.
- 🔴 The catalog is a kernel release artefact.

### B — Arbitrary graphs from agents

- 🟢 Flexible.
- 🔴 Validation proves a graph is well-formed, not that it is wanted; a model would author
  approvals and actions.

### C — Operator-created only

- 🟢 Simplest governance.
- 🔴 No process can start from a conversation.

## More Information

- Code: `middleware/src/conductor/{ephemeralRunService,ephemeralRunsCapability,ephemeralStore,ephemeralReaper,ephemeralRunStateStore,ephemeralAttachmentsStore,patternCatalog}.ts`,
  migrations `0009_ephemeral_workflows.sql`, `0010_ephemeral_attachments.sql`,
  `0012_ephemeral_run_state.sql`; `middleware/src/config.ts` (the five `CONDUCTOR_EPHEMERAL_*`).
- Tests: `middleware/test/conductorEphemeralRunService.test.ts`,
  `conductorEphemeralRunsCapability.test.ts`, `conductorEphemeralReaper.test.ts`,
  `conductorEphemeralSlugGuard.test.ts`, `conductorEphemeralRunStateStore.test.ts`,
  `conductorPatternCatalog.test.ts`.
- Related: [ADR-0132](0132-conductor-workflow-templates-are-slot-parameterized-data.md),
  [ADR-0126](0126-conductor-agent-dialogue-is-relayed-by-the-kernel.md),
  [ADR-0020](0020-proactive-agents-with-bounded-triggers.md) (the same "nothing unbounded" rule
  for triggers).
