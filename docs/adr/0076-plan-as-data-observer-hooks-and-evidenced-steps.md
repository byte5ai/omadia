# 0076 — Plan as data: turn hooks observe and never gate; a step counts as done only with evidence

## Status

Accepted

- **Date:** 2026-11-25
- **Deciders:** omadia maintainers; #188 (plan-as-data, issue #133, slices E0–E5), #241 (duplicate
  plan GC), #276 (process reuse), #1522/#1610 (step outcomes and turn-end mapping, issue #1502)
- **Supersedes:** —

## Context and Problem Statement

For multi-step requests omadia keeps an explicit plan: a `Plan` node with `PlanStep` nodes in the
knowledge graph, shown as a live card and recalled by later turns. The plan is produced by the
plugin `@omadia/plugin-plan-runner`, which needs to see a turn's start, its tool calls and its
end. This record is retroactive.

Two questions follow. How may a plugin take part in a turn without being able to break it? And
when may a later turn treat a step as finished work?

## Decision Drivers

- A planning failure must never cost the user their answer.
- Simple questions must stay latency- and cost-neutral.
- The agent runtime stays plan-agnostic.
- Recall must not hand unfinished work to a later turn as done.

## Considered Options

- **A — Observer hooks plus a plan plugin that records; evidence decides what counts as done.**
- **B — A planner that drives the loop** (plan first, execute steps, gate each step).
- **C — No explicit plan;** the transcript is the record.

## Decision Outcome

Chosen option: **A**.

- **Hooks are observers, not gatekeepers** (`turnHooks.ts`): `onBeforeTurn`, `onAfterToolCall`,
  `onAfterTurn`, `onVerifierBlocked`. A thrown hook must not abort the turn; the runner swallows
  and logs, and the orchestrator defends with its own try/catch. A hook may return a
  `TurnAnnotation { channel, payload }`, which the orchestrator forwards opaquely on the stream.
- **Gate before planning.** A cheap classifier decides per turn whether a plan is warranted and
  errs toward no plan on any failure (`gate.ts`); the fast lane's turn gate can supply the verdict
  instead. A matching learned process (`processMemory@1`, similarity threshold default 0.6) is
  materialised from its stored steps without the gate. Canvas turns do not fire `onBeforeTurn`.
- **Progress is recorded, not enforced.** During the turn the i-th work call completes the i-th
  step (`progress.ts`); a tool failure replans the remainder. Checking exit conditions with a
  model after each tool is opt-in (`verifyExitConditions`, default off). Steps the turn never
  reached end `skipped`.
- **Turn-end mapping.** One model pass after the turn maps the whole tool trace to the steps and
  corrects the stored record (`stepMapper.ts`, `mapStepsAtTurnEnd`, default on). The live card is
  not changed and the answer is not delayed; when the pass fails the in-turn result stays.
- **Evidence rule** (`isEvidencedPlanStepDone`, plugin-api). A step is done for recall and resume
  only when its status is `done` and its `resultSummary` holds a work tool's evidence or
  `PLAN_STEP_ANSWER_EVIDENCE`. Bookkeeping tools (`memory`, `v4_render_answer`,
  `suggest_follow_ups`, `ask_user_choice`) never prove work; the orchestrator flags their calls
  `toolIsBookkeeping`, and a sub-agent call whose every inner call failed is `toolFailed` even
  when it answered in prose.
- **Scope.** Plans are stored under the agent-qualified scope (`<agentSlug>::<sessionScope>`), so
  recall stays per agent.

### Consequences

- 🟢 **Good:** A broken or absent plan runner degrades to a turn without a plan card.
- 🟢 **Good:** Later turns are not told that work was finished when only a bookkeeping call ran.
- 🔴 **Bad:** The plan cannot stop a model from skipping a step; it describes the turn, it does not
  steer it beyond prompt context.
- 🔴 **Bad:** The live card uses the sequential heuristic and can credit the wrong step until the
  stored record is corrected.
- 🔴 **Bad:** A planned turn costs extra small-model calls (gate, materialiser, turn-end mapping,
  optional duplicate GC).
- ⚪ **Neutral:** Per-turn plan state is held in memory (30 minutes, 1000 entries) and evicted,
  because an errored turn never fires `onAfterTurn`.

## Pros and Cons of the Options

### A — Observer hooks, recorded plan

- 🟢 Safe by construction; runtime stays plan-agnostic.
- 🔴 No enforcement of the plan.

### B — Plan-driven loop

- 🟢 Steps are actually gated.
- 🔴 A planner fault becomes a turn fault; every turn pays the planner.

### C — Transcript only

- 🟢 No extra calls.
- 🔴 No structured progress, no reuse of learned processes.

## More Information

- Code: `middleware/packages/harness-orchestrator/src/turnHooks.ts`, `toolCallOutcome.ts`,
  `middleware/packages/harness-plugin-plan-runner/src/{plugin,gate,progress,replanner,stepMapper,gc,resume}.ts`
  and `manifest.yaml`, `middleware/packages/plugin-api/src/knowledgeGraph.ts`
  (`isEvidencedPlanStepDone`), `middleware/packages/harness-orchestrator-extras/src/contextRetriever.ts`
  (plan recall).
- Tests: `middleware/test/orchestrator/turnHooks.test.ts`, `middleware/test/planRunner.test.ts`,
  `planRunnerStepOutcome1502.test.ts`, `planStepMapping.test.ts`, `planProcessReuse.test.ts`,
  `planResume.test.ts`, `planVerifierBlock.test.ts`.
- Related: ADR-0004, ADR-0021, ADR-0040 (plan readers not yet under the read boundary),
  [ADR-0074](0074-fast-lane-one-triage-deterministic-query-any-miss-falls-back.md).
- Border: memory / knowledge graph (Plan nodes, process memory).
