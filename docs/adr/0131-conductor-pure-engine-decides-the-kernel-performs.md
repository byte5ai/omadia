# 0131 — Conductor: a pure engine decides the path, the kernel performs the steps

## Status

Accepted

- **Date:** 2026-11-25
- **Deciders:** omadia maintainers; from `specs/005-omadia-conductor/spec.md` (clarification
  session 2026-06-16), implemented in #388; later rules from #330, #1698, #1703, #1699
  (recorded retroactively from the code on main)

## Context and Problem Statement

Before the Conductor, multi-agent coordination in omadia was decided by a model: an agent
might call a sub-agent as a tool, or forget to. Nothing in the runtime owned the order of
steps or enforced a hand-off, so a process could stall silently. Operators need auditable
processes that mix agent steps, deterministic actions and human decisions. Who decides
which step comes next, and in what language is that decision written? This record is
retroactive: it documents the engine as it runs on main.

## Decision Drivers

- Step progression must never depend on a model remembering to hand off.
- The same workflow with the same step results must always take the same path (FR-006).
- A workflow is data an operator, a chat builder and a template can all author; it must be
  storable, diffable and checkable before it runs.
- A run that cannot continue must say why. It must not guess and must not hang.
- The Conductor ships in the same Docker image as the kernel.

## Considered Options

- **A — A declarative graph, decided by a pure engine package; the kernel executor performs
  the I/O**
- **B — Model-driven progression with guards** (prompt-level hand-offs plus checks)
- **C — Workflows as code** (scripts or expressions evaluated at run time)
- **D — An external workflow engine or a separate repository**

## Decision Outcome

Chosen option: **A**.

- **`@omadia/conductor-core` is pure and I/O-free** (`middleware/packages/conductor-core`).
  It owns the types, the JSON schema, `validate()`, `evaluatePredicate()` and `nextStep()`.
  The kernel side (`middleware/src/conductor/`) owns persistence and effects; the seam is
  `StepEffects` (`stepEffects.ts`), which preview and tests replace with fakes.
- **A workflow is a graph of data:** steps of kind `agent`, `action`, `human` or `timer`,
  transitions with optional guards, an `entryStepId`, and triggers. Triggers of every kind
  funnel into one entry point, `ConductorRunExecutor.startRun`.
- **Guards and exit postconditions are a predicate AST, never code.** Operators: `eq`, `ne`,
  `gt`, `lt`, `gte`, `lte`, `exists`, `in`, `matches`, `and`, `or`, `not`, `always`, `never`,
  over dot-paths rooted at `ctx` and `stepResult`. Evaluation is total: a missing path or a
  type mismatch is `false`, never a throw. A comparison against an unresolvable `valuePath`
  is `false` for every operator including `ne`, so a loop guarded by a missing budget stops.
- **`nextStep()` decides, in this order:** an unmet postcondition fires the step's
  `fallbackTransitionId`; otherwise exactly one matching happy-path guard advances; more
  than one match is `stuck` (`ambiguous_guards`); none fires the fallback, completes a
  terminal step, or is `stuck`. The engine never picks among candidates.
- **`stuck` is a recorded outcome.** The executor ends the run `failed` with a typed cause
  (`runError.ts`); the `MAX_STEPS = 1000` budget ends a run the same way
  (`max_steps_exceeded`).
- **Validation refuses what cannot run:** unreachable steps, a cycle made only of unguarded
  transitions, a deadline or timer without a fallback, `quorum: 'all'` without deadline and
  fallback, missing per-kind config. Legal but dangerous shapes are non-blocking warnings.
- **Loops are bounded by the executor, not by the model:** `ctx.stepAttempts.<stepId>` is
  bumped before each step, so a guard such as `lt ctx.stepAttempts.speak ctx.maxTurns` is a
  deterministic ceiling.
- **An effect may supply a default postcondition** for a step that declares none
  (`NextStepOptions.defaultPostcondition`, used by `webhook.post`); a step's own
  postcondition always wins.
- **In the repo, modular.** No separate repository, no external engine.

### Consequences

- 🟢 **Good:** Progression is reproducible and unit-testable without a database or a model.
- 🟢 **Good:** The designer, the chat builder, templates and `POST /conductors` all produce
  the same graph and get the same verdict from one `validate()`.
- 🔴 **Bad:** The predicate language is deliberately small. A condition it cannot express
  needs an agent step that emits a fenced `json` verdict (`stepResult.data`) or an action.
- 🔴 **Bad:** `matches` compiles an operator-authored regular expression per evaluation; an
  invalid pattern is `false`, a slow one is not bounded.
- 🔴 **Bad:** A graph with overlapping guards publishes and only fails at run time as
  `ambiguous_guards`.
- ⚪ **Neutral:** No parallel branches and no sub-workflow call; the deadline fallback is an
  in-graph transition only (spec clarification). N-of-M quorum is out of scope.

## Pros and Cons of the Options

### A — Declarative graph, pure engine

- 🟢 Deterministic, testable, serializable.
- 🔴 Less expressive than code.

### B — Model-driven progression

- 🟢 No new engine.
- 🔴 The stall the feature exists to remove stays possible.

### C — Workflows as code

- 🟢 Fully expressive.
- 🔴 Operator-authored code in the kernel process; not validatable before it runs.

### D — External engine or separate repository

- 🟢 Mature durability features.
- 🔴 The spec rejected a separate repo: internal `@omadia/*` packages would have to be
  published and versioned across repos for something that ships as one image.

## More Information

- Code: `middleware/packages/conductor-core/src/{engine,predicate,validate,types}.ts`,
  `schema/conductor-graph.schema.json`; `middleware/src/conductor/{runExecutor,stepEffects,runError}.ts`.
- Tests: `packages/conductor-core/test/{engine,predicate,validate,fixtures}.test.ts`,
  `middleware/test/conductorRunFailureCause.test.ts`.
- Spec: `specs/005-omadia-conductor/spec.md` FR-001 to FR-009, FR-032.
- Related: [ADR-0012](0012-agents-are-virtual-employees.md) (the Conductor is part of the
  management layer), [ADR-0042](0042-conductor-event-ids-belong-to-the-sender.md),
  [ADR-0128](0128-conductor-durable-runs-lease-fencing-and-reconcile.md),
  [ADR-0130](0130-conductor-human-steps-awaits-roles-and-approval.md).
