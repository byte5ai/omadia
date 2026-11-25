# 0056 — The Builder model works behind deterministic gates; loops are bounded and a turn outlives its connection

## Status

Accepted

- **Date:** 2026-11-25
- **Deciders:** omadia maintainers (recorded retroactively from the code on main); turn
  survival from #1899, session-bound event stream from #1286
- **Supersedes:** —

## Context and Problem Statement

The Plugin Builder's model edits a draft through tools until the code compiles. Left alone, a
model reaches "green" by the cheapest route: it removes the tool that does not compile, repeats
the same failing fix, or declares success on code that crashes at activation. A turn takes
minutes; browsers reload and proxies cut idle connections.

This record is retroactive. What may the Builder model decide on its own, what is decided by
code, and what bounds a turn?

## Decision Drivers

- Deterministic first ([ADR-0021](0021-deterministic-first-side-channels-and-uncluttered-answers.md)):
  what code can check, a model does not judge.
- A capability the operator asked for must not vanish silently.
- A loop must stop by itself and say why.
- A dropped connection must not cost a second model run.

## Considered Options

- **A — Tool-only mutation, with a chain of deterministic gates per mutation and hard caps on
  every loop; turns run detached with a replay buffer**
- **B — Let the model self-review** (a second model pass judges the draft)
- **C — Gate only at install time**

## Decision Outcome

Chosen option: **A**.

- **Gates on every mutation.**
  - `fill_slot` persists the slot, then runs codegen → import check → `tsc --noEmit`
    (`slotTypecheckPipeline.ts`, one mutex per draft) and returns the errors in the same tool
    result. `workspaceImportResolver.ts` refuses unresolvable and forbidden imports before `tsc`.
  - `patch_spec` runs the **content guard** (`contentGuard.ts`): a patch that removes entries
    from `tools`, `setup_fields`, `depends_on` or `network.outbound` is rejected unless the
    operator's latest message names the removed id (case-insensitive substring; deliberately
    lax, because a silent removal is the costlier error). Adding is always allowed.
  - The **manifest linter** (`manifestLinter.ts`) checks what compiles but fails at install:
    unknown or self-referencing `depends_on`, duplicate or non-snake_case tool ids, wildcard or
    URL-shaped outbound hosts, duplicate setup keys, reserved ids.
- **Runtime smoke after a successful build** (`runtimeSmoke.ts`): activate through the preview
  runtime, call every tool with a synthetic input from its schema (10 s per tool), probe admin
  routes. Pass = no crash and no timeout; a Zod rejection of the synthetic input and an
  upstream 401 on stub credentials count as controlled exits.
- **Caps.** 20 model iterations per turn and 8 consecutive slot type-check failures
  (`builderAgent.ts`); a 15-minute turn timeout (`builderChat.ts`); the operator-job budgets of
  `PLUGIN_BUILDER_TURN` (150 calls, 20 min) and `PLUGIN_BUILDER_AUTOFIX` (300 calls, 30 min)
  ([ADR-0017](0017-model-gateway-and-execution-contexts.md)).
- **Auto-fix is opt-in and self-stopping.** `spec.builder_settings.auto_fix_enabled` defaults
  to `false`. When on, `AutoFixOrchestrator` turns a failed build or smoke run into one
  synthetic turn per build; the same failure fingerprint on 3 consecutive attempts
  (`MAX_IDENTICAL_ATTEMPTS`) emits `stopped_loop` and switches the flag off again.
- **A turn is detached from its HTTP stream.** `POST /drafts/:id/turn` answers NDJSON with
  monotonic frame ids; a client disconnect does not cancel the generator. Frames are kept per
  turn (`turnRingBuffer.ts`: 1,024 events, collected 10 minutes after the turn ends), and
  `GET /drafts/:id/turn/:turnId/resume?since=N` replays and continues. Heartbeats are not
  recorded. The spec event stream (`GET /drafts/:id/events`, SSE) ends with the session that
  opened it and re-checks the session on every heartbeat.
- **Mutating builder tools are audited** in `builder_audit` (`audit.ts`), fire-and-forget.

### Consequences

- 🟢 **Good:** "Compiles" and "activates and answers" are facts from code, in the same turn.
- 🟢 **Good:** The cheap way out (drop the tool) is closed without a second model.
- 🟢 **Good:** A reload or a proxy timeout costs nothing; two tabs stay in sync.
- 🔴 **Bad:** The content guard's intent check is a substring match: it lets a removal through
  when the id merely appears in the message and blocks one phrased without the id.
- 🔴 **Bad:** Smoke proves "does not crash", not "is correct"; a tool that returns nonsense
  passes.
- 🔴 **Bad:** Ring buffer, pending user choices (`userChoiceCoordinator.ts`), auto-fix loop
  state and last build status are in memory: a restart loses a running turn and its replay, and
  none of it works across more than one middleware instance.
- ⚪ **Neutral:** A failed audit write is swallowed by design; the audit trail of builder edits
  is best-effort.

## Pros and Cons of the Options

### A — Deterministic gates and caps

- 🟢 Cheap, reproducible, explains itself.
- 🔴 Heuristic in one place (removal intent).

### B — Model self-review

- 🟢 Could judge semantics.
- 🔴 Costs a second run per step and is not reproducible; contradicts ADR-0021.

### C — Gate at install only

- 🟢 Simplest loop.
- 🔴 The operator learns of a broken draft after minutes of work, with no in-turn correction.

## More Information

- Related: [ADR-0017](0017-model-gateway-and-execution-contexts.md),
  [ADR-0021](0021-deterministic-first-side-channels-and-uncluttered-answers.md);
  [ADR-0064](0064-plugin-builder-spec-and-slots-into-boilerplate-templates.md),
  [ADR-0059](0059-builder-preview-in-process-with-captured-tools.md).
- Paths: `middleware/src/plugins/builder/{builderAgent,contentGuard,manifestLinter,slotTypecheckPipeline,workspaceImportResolver,runtimeSmoke,runtimeSmokeOrchestrator,autoFixOrchestrator,turnRingBuffer,audit}.ts`,
  `middleware/src/routes/{builderChat,builderEvents,builderEventsSession}.ts`,
  `middleware/src/platform/modelWorkKinds.ts`.
- Tests: `middleware/test/builder/{contentGuard,manifestLinter,runtimeSmoke,autoFixOrchestrator,turnRingBuffer,builderChatRoutes,builderEventsSession,builderAgentStream}.test.ts`,
  `middleware/test/builder/tools/{fillSlot,fillSlotBudget,patchSpec,lintSpec}.test.ts`.
