# Implementation & Integration Plan: Omadia Conductor

**Feature Branch**: `005-omadia-conductor`
**Inputs**: `spec.md`, `data-model.md` (this directory)
**Created**: 2026-06-17
**Status**: Draft — grounded against the live codebase (worktree off `main`)

> This plan was produced by reading both spec artifacts and then grounding every
> primitive the spec leans on against the **real** middleware/web-ui code. Each
> phase below names the exact files to reuse, the seam to hook, the net-new code,
> and the integration risk. The "Landmines" section (§7) is the deep-search output:
> every place the spec's assumptions diverge from what actually exists today.

---

## 1. Executive Summary

Conductor is **mostly an assembly job on top of mature primitives, plus three genuinely
net-new substrates**. The headline engine (`@omadia/conductor-core`) is a pure package
that fits the established `@omadia/canvas-core` mold exactly. The event-catalog
autodiscovery is a near-verbatim clone of the shipped `canvasOutputRegistry` /
`deterministicActionRegistry` pattern. The Designer reuses the Agent Builder's React-Flow
canvas, optimistic-mutation hook, and REST conventions.

The three things that **do not exist today** and carry the real risk:

1. **A durable await** (`conductor_awaits`) — `ask_user_choice` is not just in-memory, it
   does not survive a single turn boundary. This is greenfield.
2. **`ctx.events.emit` + the event bus** — no event surface exists on `PluginContext`
   today; `notifications.send` is channel fan-out, not an event bus.
3. **A multi-agent preview + a multi-agent run executor** — `previewRuntime` and the
   orchestrator are strictly single-agent; the run executor that drives a *graph* of
   agent/human/action steps is net-new (the engine decides the path; the executor
   performs the I/O for each step).

Two cross-cutting constraints shape everything: **(a)** all persistence is gated on the
Neon `graphPool`, which is `undefined` on the in-memory backend — Conductor must
degrade-skip exactly like routines/schedules do; **(b)** there is **no central migration
runner** — each subsystem ships its own migrator.

**Recommended sequencing** (matches the spec's P1→P2→P3 and the Agent-Builder precedent):
engine-core → durable run lifecycle → triggers (incl. event surface) → human steps &
awaits → roles → Designer → preview → audit.

---

## 2. Architecture Placement & Package Topology

Per the 2026-06-16 clarification (in-repo, modular). Confirmed feasible against the
existing package layout (`middleware/packages/*`, kernel `middleware/src/*`, `web-ui/app/*`).

| Layer | Location | Mirror of | Notes |
|---|---|---|---|
| Pure engine | `middleware/packages/conductor-core/` | `middleware/packages/canvas-core/` | ajv-only runtime dep; schemas as `*.schema.json` + generated validators; fixture-driven vitest. `@omadia/plugin-api` as **devDep only** to stay I/O-free. |
| Kernel wiring | `middleware/src/conductor/` (new dir) | `middleware/src/scheduler/`, `middleware/src/plugins/routines/` | Stores (`*Store.ts` over `graphPool`), the run executor, the await worker, the event router, the role-resolver registry, the migrator. |
| Manifest extension | `middleware/src/api/admin-v1.ts` + `middleware/src/plugins/manifestLoader.ts` | existing `provides:` / `PluginPermissionsSummary` | Add `emits:` parsing and an `events_emit` permission. |
| Plugin contract | `middleware/packages/plugin-api/src/` | `pluginContext.ts` accessors | Add `EventsAccessor` + `readonly events?` on `PluginContext`; add `emits`/`events` types. |
| Designer (web-ui) | `web-ui/app/admin/conductor/` | `web-ui/app/admin/builder/` | React-Flow canvas + `useConductorGraph` (clone of `useAgentGraph`) + `conductorBuilder.ts` REST client. |
| Designer chat agent | `middleware/src/conductor/builder/` | `middleware/src/plugins/builder/builderAgent.ts` | New conductor-spec patch toolset + system prompt. |
| Operator API | `middleware/src/routes/conductor*.ts` mounted at `/api/v1/operator/conductors/*` behind `requireAuth` | `routes/operatorAgents.ts` | All writes through `/bot-api` → cookie-JWT. |

**Boot wiring** lands in `middleware/src/index.ts` next to `ScheduleWorker`/`initRoutines`,
all `if (graphPool) { … }`-gated (see §4 Phase 2, §7-F).

---

## 3. Reuse Map — spec primitive → real artifact → status

Legend: ✅ reuse as-is · 🔶 reuse + extend · 🆕 net-new (no precedent) · ⚠️ mismatch to resolve

| Spec calls for | Real artifact (grounded) | Status |
|---|---|---|
| `@omadia/conductor-core` pure engine | `middleware/packages/canvas-core/` (ajv-only, fixture-tested) | ✅ template |
| `buildOrchestratorForAgent` for agent steps | `middleware/packages/harness-orchestrator/src/buildOrchestrator.ts` L155 | ✅ (note: `buildOrchestrator` is test-only) |
| verifier / postconditions | `harness-verifier/src/verifierPipeline.ts`; kernel `verifierService.ts` | 🔶 verify exists; postcond = Zod-output only; binding is kernel-side |
| OB-31 obligation / repeat-failure guards | `harness-orchestrator/src/localSubAgent.ts`; `loopGuard.ts` | 🔶 in-memory, per-`ask()`, no process scope |
| deterministic-action fast-path | `deterministicActionRegistry.ts`; `omadia-ui-orchestrator/src/plugin.ts` L442-480 | ⚠️ canvas/UI-action-shaped, not a general step skip |
| `serviceRegistry` seam | `middleware/src/platform/serviceRegistry.ts` (`provide`/`get`/`replace`) | ✅ |
| declare→resolve→derive autodiscovery (event catalog) | `canvasOutputRegistry.ts` + `dynamicAgentRuntime.ts` activate/deactivate L524-572 | ✅ exact template — but resolve hook is dynamic-agents-only (§7-K) |
| manifest `provides:` / `permissions:` | `admin-v1.ts` `Plugin` L222+, `PluginPermissionsSummary` L69; `manifestLoader.ts` `adaptManifestV1` | 🔶 no standalone `manifestLinter`; catalog startup-cached |
| `ctx.events.emit` | — none — closest is `notifications.send` (fan-out) | 🆕 |
| `scheduleWorker` / `agent_schedules` for cron + await polling | `middleware/src/scheduler/scheduleWorker.ts`; `migrations/0003` | 🔶 DB-durable rows, but in-memory dedup, UTC-only, no due-poll/claim |
| proactive sender / channel notify | `plugins/routines/proactiveSender.ts`; `channels/channelRegistry.ts` | ⚠️ Teams only; registry in-memory; no user→conversationRef store |
| durable await (replaces `ask_user_choice`) | `harness-orchestrator/src/tools/askUserChoiceTool.ts` (per-turn instance field) | 🆕 |
| inbound channel → run trigger | `channels/coreApi.ts` `handleTurnStream`; `orchestratorDispatcher.ts` | ✅ hook point; keyed on agent-binding not user |
| webhook trigger | channel-transport-specific (`/api/messages`, Telegram) | ⚠️ no generic ingress route |
| `users` table / `user:<id>` principal | `middleware/src/auth/userStore.ts`; `auth/migrations/0001_users.sql` | 🔶 auth-only; no channel-binding join |
| Agent Builder canvas (React-Flow) | `web-ui/app/admin/builder/BuilderCanvas.tsx` (`@xyflow/react`) | 🔶 hard-coded to single-agent `AgentGraph` topology |
| optimistic-mutation + REST | `web-ui/app/admin/builder/useAgentGraph.ts`; `_lib/agentBuilder.ts`, `_lib/api.ts` | ✅ copy `mutate` shape + dual-path client |
| conversational builder agent + `patch_spec` | `middleware/src/plugins/builder/builderAgent.ts`; `tools/patchSpec.ts` | 🔶 mutates AgentSpec; needs conductor spec/tools/prompt |
| `previewRuntime` (multi-agent preview) | `plugins/builder/previewRuntime.ts` (one ZIP→one agent) | 🆕 multi-agent preview |
| run persistence / resume | spec 001 config tables + `routine_runs` (audit) + `ReloadBus` D3 | 🆕 durable in-flight run/resume; reuse `routine_runs` column shape + notify/reconcile |
| migration conventions | `middleware/migrations/` + per-subsystem migrators (`runAuthMigrations` etc.) | ✅ TEXT+CHECK; ship a `runConductorMigrations` |
| DB pool | `serviceRegistry.get<Pool>('graphPool')` (owned by KG-Neon plugin) | ✅ gate all persistence on it |
| `pg_notify` + LISTEN | `migrations/0001-0002` `notify_*`; `harness-orchestrator/src/registry/reloadBus.ts` | 🔶 real, but `enableListen=false` default (pool budget) |
| operator auth | `auth/requireAuth.js`; session-scoped handlers | ✅ mount conductor routes behind it |

---

## 4. Build Sequence

Each phase is independently testable and ordered so every later phase builds on a landed,
verified substrate (the spec's own sequencing rationale). Phase ↔ User Story ↔ Priority
mapping is noted.

### Phase 0 — Foundations (enabling, no user story)

- **`middleware/packages/conductor-core/`** scaffold mirroring `canvas-core`: `package.json`
  (`main: dist/src/index.js`, ajv runtime dep, plugin-api devDep), `tsconfig`, `src/index.ts`,
  `schema/`, `fixtures/`, `test/`, `tools/genValidator.ts`.
- **`runConductorMigrations` + `_conductor_migrations`** tracking table, following the
  `runAuthMigrations`/`runRoutineMigrations` template verbatim (`CREATE TABLE IF NOT EXISTS`,
  read applied set, sorted `.sql` apply in `BEGIN/COMMIT`). `MIGRATIONS_DIR` resolved relative
  to the migrator module. Wired into `index.ts` boot under `if (graphPool)`.
- **`0001_conductor.sql`**: all `conductor_*` tables from `data-model.md`, TEXT+CHECK enums,
  `TIMESTAMPTZ DEFAULT now()`, partial indexes (`conductor_runs_waiting_idx`,
  `conductor_awaits_due_idx`), and the two `notify_*` trigger functions
  (`notify_await_resolved`, `notify_role_changed`).

### Phase 1 — Deterministic Engine `conductor-core` (US1, P1) ✅ low risk

- **Build**: `validate(graph)` (reachability, unguarded-cycle, deadline-without-fallback,
  unknown-reference checks) and `nextStep(graph, currentStepId, stepResult, ctx): Decision`
  (postcondition verdict → matching guarded transition → fallback → `Stuck` error).
- **Reuse**: pattern from `canvas-core` validators; ajv for the `graph` JSON-schema.
- **Net-new**: the graph schema itself, the guard-evaluation language, the postcondition
  representation (see §7-D — must be a real predicate language, not Zod-output reuse).
- **Test (SC-009)**: property/fixture tests, zero I/O — identical inputs → identical path;
  reject-corpus for invalid graphs naming the offending node.
- **Risk**: low. This is the cleanest reuse. The only design decision is the
  guard/postcondition expression language (recommend a small, serializable predicate AST
  over `ctx`/`stepResult`, JSON-schema-validated — NOT JS eval).

### Phase 2 — Durable Run Lifecycle & Resume (US2, P1) 🆕 high value

- **Build**: `ConductorRunStore` + `ConductorRunStepStore` (`pg`, over `graphPool`); a
  **run executor** that loads a run, asks `conductor-core.nextStep`, performs the step's I/O
  (agent turn / action / human dispatch), persists step + context **before** advancing
  (FR-004), and parks the run in `waiting` for human/timer/event signals.
- **Reuse**: `routine_runs` column shape for the audit fields; `ReloadBus` notify/reconcile
  pattern (`reloadBus.ts`) for resume; `serviceRegistry.get('graphPool')`.
- **Resume**: `LISTEN conductor_await_resolved` → resume named run; **60s reconcile**
  (scan `status='waiting'` + due awaits) as the authoritative fallback. See §7-E: rely on
  reconcile first; treat LISTEN as an optimization, because `enableListen=false` by default.
- **Test (SC-002)**: start → advance to waiting → restart process → deliver signal → resume
  at correct step, no step re-executed/skipped. Step that throws/times out → recorded
  `failed`/fallback, never an unrecorded hang (FR-005).
- **Risk**: medium-high. Net-new state machine; the at-most-once step execution under
  restart + concurrent reconcile is the crux (§7-G idempotency).

### Phase 3 — Triggers & the Event Surface (US3 + US4, P1) 🆕 + ✅

- **Single funnel** `startRun(workflowId, payload)` (FR-007). Trigger kinds:
  - `manual` (UI/API) — new operator route. ✅
  - `cron` — reuse `ScheduleWorker`; map a workflow cron trigger to an `agent_schedules`-style
    row OR a parallel `conductor_schedules` table polled by the same worker tick. 🔶 (§7-A)
  - `channel` — hook `coreApi.handleTurnStream` / `TurnDispatcher.streamTurn`. ✅
  - `agent` — a `start_workflow` native tool (FR-008). 🆕 small
  - `webhook` — **new generic ingress route** (no precedent; §7-I). 🆕
  - `workflow` — internal call into `startRun`. ✅
  - `event` — the Conductor Surface (below). 🆕
- **Event Surface (US4)**:
  - `emits:` manifest block + `permissions.events.emit` parsing in `adaptManifestV1`
    (`admin-v1.ts` + `manifestLoader.ts`). 🔶
  - **`EventCatalogRegistry`** = copy `CanvasOutputRegistry`; `eventCatalogToolIds`-equivalent
    extractor; register/unregister in `dynamicAgentRuntime.activate/deactivate` (L524-572).
    ⚠️ **Verify built-in/static plugins also resolve** their `emits:` — the canvas-output hook
    is wired only for the dynamic runtime (§7-K).
  - **`ctx.events.emit(id, payload)`** — new `EventsAccessor` on `PluginContext`
    (`plugin-api/src/pluginContext.ts`), provisioned in `createPluginContext`
    (`middleware/src/platform/pluginContext.ts`), gated on the new permission, validates
    payload against the catalog schema, rejects+logs non-conforming, routes to subscribed
    workflows. 🆕 (§7-B)
- **Disabled/missing workflow** (FR-009): suppressed trigger logged, never dropped.
- **Test (SC-004/005)**: fixture connector with `emits:` → catalog lists it → valid emit
  starts a subscribed run, schema-violating emit starts none and is logged → uninstall removes
  it and subscribers surface "trigger source missing".
- **Risk**: medium. The event accessor is net-new contract surface; the static-plugin
  resolve coverage is the sneaky gap.

### Phase 4 — Human Steps & Durable Awaits (US5, P1) 🆕 highest net-new

- **Build**: `ConductorAwaitStore` + `ConductorAwaitResponseStore`; an **await worker** that
  polls `conductor_awaits_due_idx` on the `ScheduleWorker` tick: send reminder when
  `now ≥ last_reminder_at + reminder_interval_ms`; fire fallback transition when
  `now ≥ deadline_at`, closing the await `timed_out` (FR-015..FR-019).
- **Reuse**: `proactiveSender` for notification (FR-016); `ScheduleWorker` tick for timing.
- **Net-new**: the durable await itself (greenfield vs `ask_user_choice`); atomic
  `waiting → {resolved,timed_out}` resolution (FR-018, §7-G); the response-ingestion path
  (how a human's channel reply / UI click resolves a specific await — correlation id).
- **Critical dependency**: notification needs a **user→channel conversationRef** mapping that
  does not exist today (§7-C). This is a blocking sub-task, not a detail.
- **Test (SC-003)**: clock-driven reminder + deadline-fallback for both `quorum: any` and
  `all`; late response after resolution rejected and logged (no double-advance).
- **Risk**: high. Two net-new substrates (await + conversationRef store) + atomic resolution.

### Phase 5 — Principals & Role Resolver (US6, P1) 🆕 + ✅ seam

- **Build**: `conductor_roles` + `conductor_role_assignments` stores; **`RoleResolver`
  registry** via `serviceRegistry.provide('roleResolver', …)` (same seam as canvasOutputRegistry);
  a **default resolver** reading `conductor_role_assignments`; baton-move API
  (close one assignment, open another) firing `role.assignment.changed` / `await.reassigned`
  (FR-021..FR-025).
- **Late binding** (FR-022): resolve at dispatch + on each reminder. **Access at access time**
  (FR-023): await read/answer authorized against the role's *current* holders — not frozen.
- **No-holder** (FR-024): unmet postcondition → fallback (reuses the harness, no special-case).
- **Test (SC-006/007)**: baton A→B transfers reminder target + await access; no-holder → fallback.
- **Risk**: medium. The resolver seam is clean; the access-at-access-time authorization on the
  await read/answer routes is the subtle part (must re-resolve on every read, §7-C).

### Phase 6 — Conductor Designer (US7, P2) 🔶 fuse two builders

- **Build**: `web-ui/app/admin/conductor/` mirroring `app/admin/builder/`: a React-Flow canvas
  (`@xyflow/react`), `useConductorGraph` (clone `useAgentGraph.mutate` optimistic-rollback),
  `conductorBuilder.ts` REST client (dual-path cookie-forward, clone `_lib/agentBuilder.ts`),
  node/edge/inspector components for step/transition/trigger; a **conductor builder agent**
  (clone `builderAgent` + a new patch toolset that mutates the conductor draft graph + a new
  system prompt). Versioned save (draft → version snapshot) per FR-027.
- **Reuse**: optimistic-mutation + REST ✅; canvas shell 🔶; builder-agent architecture 🔶.
- **Net-new**: conductor graph topology in the canvas (single-agent `AgentGraph`/`graphToFlow`
  does not fit — §7-L); the conductor draft spec schema + patch/lint tools.
- **Designer sources triggers from the live event catalog** (FR-028) with payload-field
  autocomplete from the declared schema.
- **Test (SC-001/008)**: build agentic+human workflow no-code; edit+resave → new version while
  in-flight run on prior version unaffected; invalid graph blocks save naming the check.
- **Risk**: medium. Mostly extension, but "visual + conversational" fuses two today-separate
  subsystems (admin/builder canvas vs store/builder chat).

### Phase 7 — Dry-Run / Preview (US8, P2) 🆕 hardest-missing

- **Build**: a **multi-agent preview executor** — runs the engine path with preview-scoped
  tools, operator answers human steps inline (no real notification / durable await), connector
  actions flagged irreversible are stubbed (FR-029).
- **Net-new**: `previewRuntime` is strictly one-ZIP→one-agent with no routing/hand-off; this
  needs either orchestrating multiple preview handles behind the engine, or a purpose-built
  preview executor that shares the Phase-2 run executor with an injected "preview I/O adapter".
- **Recommendation**: build the Phase-2 run executor with a pluggable **StepEffects interface**
  (notify / await / call-action / run-agent-turn) so preview is just an alternate StepEffects
  impl — avoids a parallel executor.
- **Risk**: medium-high. Genuinely net-new; de-risked if Phase 2's executor is built with the
  StepEffects seam from the start (do this — it is cheap up front, expensive to retrofit).

### Phase 8 — Run Audit & Observability (US9, P3) ✅ on existing trace

- **Build**: surface `conductor_run_steps` (already written each step in Phase 2) through
  omadia's existing per-run trace / call-stack viewer; record trigger, ordered steps, actor,
  postcondition outcome, transitions (incl. fallback), reminders, baton resolutions, event
  origin (redaction-respecting) — FR-030.
- **Reuse**: the existing viewer stack (`RunTrace`/`RunTraceCollector` →
  `routine_runs.run_trace JSONB` → `GET /:id/runs/:runId` → `web-ui/app/routines/_components/RunTraceViewer.tsx`)
  + its redaction. **Caveat (VERIFIED)**: `RunTraceViewer` is **shape-aware** (typed to
  `{iterations, orchestratorToolCalls, agentInvocations}`), not a generic JSON tree, and `RunTrace`
  is orchestrator-tool-call-shaped — it does not fit the `conductor_run_steps` ordered-step model
  1:1. **Decision**: add a Conductor-specific branch/variant of `RunTraceViewer` driven by
  `conductor_run_steps` (trigger · ordered steps · actor · postcondition outcome · transition ·
  reminders · baton resolutions) rather than forcing steps into the tool-call schema. Surfaced via
  new `GET /api/v1/operator/conductors/:slug/runs(/:runId)` routes mirroring the routines routes.
- **Test (SC-010)**: completed run trace contains all required elements ordered.
- **Risk**: low-medium. The data is already persisted by Phase 2/4/5; the only real work is the
  Conductor-shaped viewer branch (the generic viewer cannot be reused verbatim).

---

## 5. Net-New Substrate (no precedent — budget accordingly)

These five are the real engineering, ranked by risk:

1. **Durable await + atomic resolution** (Phase 4) — greenfield; `ask_user_choice` gives nothing.
2. **Multi-agent run executor + resume** (Phase 2) — the engine decides; the executor performs
   I/O and survives restart. Build with the **StepEffects seam** so preview (Phase 7) reuses it.
3. **`ctx.events.emit` + event router** (Phase 3) — new contract surface on `PluginContext`.
4. **User→channel conversationRef store** (Phase 4 dependency) — required to notify a `user:<id>`
   principal proactively; today the handle lives only on `routines` rows (§7-C).
5. **Conductor graph topology in the canvas + conductor builder toolset** (Phase 6) — the
   single-agent `AgentGraph` does not model a multi-step process.

---

## 6. Cross-Cutting Engineering Decisions

- **Engine purity (FR-032)**: `conductor-core` does zero I/O. Guards/postconditions are a
  **serializable predicate AST**, evaluated by the engine over `{ctx, stepResult}`. No `eval`,
  no LLM call, no DB. This is what makes SC-009 (determinism) and isolated unit-tests possible.
- **StepEffects seam**: the run executor takes a `StepEffects` interface
  (`runAgentTurn`, `runAction`, `dispatchHuman`, `notify`, `emit`). Production wires real
  implementations; preview (US8) and tests wire fakes. Decided up front (§4 Phase 7 rationale).
- **graphPool gating**: every store/worker is `if (graphPool)`-guarded; on the in-memory
  backend Conductor is inert (no runs, catalog read-only) — matches routines/schedules.
- **Versioning (FR-027)**: runs bind `workflow_version_id` (immutable); drafts are mutable;
  publish snapshots draft→version. The engine validates a version before publish.
- **Multi-replica**: out of scope per spec (single-process scheduler reused), but the
  in-memory dedup in `ScheduleWorker` means **do not run two replicas of the await/cron worker**
  without a DB claim. Document the single-worker constraint loudly (§7-A).

---

## 7. Landmines, Risks & Open Questions (deep-search output)

Every divergence the grounding found between the spec's assumptions and the live code.

**A. Two schedulers — the biggest conflation.** `ScheduleWorker` + `agent_schedules`
(`middleware/src/scheduler/scheduleWorker.ts`, `migrations/0003`) is DB-durable (rows survive
restart) but its per-minute dedup + in-flight set are **in-memory** → not multi-replica safe,
and it is **UTC-only** (`cron.ts`). The *other* scheduler — `JobScheduler`
(`middleware/src/plugins/jobScheduler.ts`, "does not persist anything across process restarts")
+ `RoutineRunner` — is **not** durable. **Decision (RESOLVED #2/#3)**: build on `ScheduleWorker`
(durable rows); add a sibling `conductor_schedules` table + a **due-row claim via
`FOR UPDATE SKIP LOCKED`** for both cron and awaits; do not reuse `JobScheduler`. Reminder/
deadline timing inherits minute granularity (acceptable per spec Assumptions). The DB claim
**supersedes** the in-memory dedup, making the worker multi-replica-safe from day one.

**B. `ctx.events.emit` does not exist.** No `events`/`bus` accessor on `PluginContext` today
(`bus` is a reserved-but-unwired `ServiceName`). **Decision (RESOLVED)**: (1) add `EventsAccessor`
+ `readonly events?` to `plugin-api/src/pluginContext.ts`; (2) add an `events_emit` field to
`PluginPermissionsSummary` (`admin-v1.ts`) + loader parse, gating it `subAgents`/`llm`-style
(empty permission → accessor `undefined`); (3) provision the accessor in `createPluginContext`
(`middleware/src/platform/pluginContext.ts`) wired to a new **`middleware/src/conductor/eventRouter.ts`**.
The router validates `payload` against the `EventCatalogRegistry` schema for the installed
`schema_version`, rejects+logs non-conforming emits, stamps provenance, and calls `startRun` for
every subscribed workflow whose filter matches. The router is the single consumer the
`ctx.events.emit` impl delegates to — keeping the plugin-api surface thin.

**C. No user→channel conversationRef mapping.** `users` (`auth/userStore.ts`) is auth-only;
the proactive conversationRef lives only on `routines.conversation_ref`, and the proactive
sender registry is **in-memory, Teams-only** (Telegram declared-not-implemented). Resolving a
`user:<id>` or a role-resolved holder to "which channel + ref to notify" has **no join today**.
**Decision (RESOLVED #1)**: net-new durable `conductor_channel_bindings (user_id, channel_type,
conversation_ref JSONB)` store, PK `(user_id, channel_type)`, decoupled from `routines`. Resolved
at dispatch; a binding miss creates the await flagged `unreachable` and fires the workflow's
configurable fallback (default behavior). Provisioning the binding rows reuses existing channel
mechanisms (operational concern per spec Assumptions). MVP ships Teams; Telegram sender is
declared-not-implemented and tracked separately.

**D. Postconditions are Zod-output-conformance only.** Today a postcondition = an optional
`output?: z.ZodType` on a bridged tool, checked per tool-call in `bridgeTool`
(`dynamicAgentRuntime.ts` L743-796 → `[POSTCONDITION_FAILED]` → verifier `tool_postcondition`
claim). There is **no general predicate/assertion language**. Conductor's *step exit
postcondition* is a richer concept (assert over run context, not just one tool's output shape).
**Decision**: define the postcondition AST in `conductor-core` (§6); the per-tool Zod check
remains a *separate*, lower layer used inside agent steps.

**E. LISTEN/NOTIFY is disabled by default.** `pg_notify` machinery is real
(`migrations/0001-0002`, `reloadBus.ts`) but `ReloadBus.enableListen=false` by default because
LISTEN pins one connection and the KG pool is `max:5` (deadlock risk on boot). **Decision**:
make the **60s reconcile poll the authoritative resume path**; treat LISTEN as an optional
latency optimization to be enabled only after the connection-budget is addressed (dedicated
`DATABASE_URL` connection or raised pool max). Do not design the await-resume happy path to
*require* live NOTIFY.

**F. graphPool only exists with Neon.** `serviceRegistry.get<Pool>('graphPool')` is `undefined`
on the in-memory KG backend (`DATABASE_URL` unset). All Conductor persistence/workers must
degrade-skip. **Risk if ignored**: boot crash on dev/in-memory setups.

**G. At-most-once step execution + atomic await resolution.** The hardest correctness problem.
A `waiting` run resumed by both a NOTIFY and the reconcile poll, or a deadline firing while a
response is in flight, must not double-advance. **Decision**: resolve `conductor_awaits`
`waiting → {resolved,timed_out}` with a single conditional `UPDATE ... WHERE status='waiting'
RETURNING` (the row update is the lock; the `notify_await_resolved` trigger only fires on the
真 transition `OLD.status='waiting'`). Step execution claims the run via an optimistic
`current_step_id` + `status` CAS before performing I/O.

**H. `VerifierService` is kernel-side, not in `@omadia/verifier`.** The package exposes
`VerifierPipeline.verify`, but the binding that actually drives postcondition→retry
(`verifierService.ts`, consumes ~7 kernel-internal symbols) is deliberately kernel-side.
Conductor agent-steps that want the retry behavior must depend on the **kernel** binding, not
just the package.

**I. No generic webhook ingress.** Webhooks today are channel-transport-specific
(Teams `/api/messages`, Telegram). **Decision (RESOLVED)**: add a new generic route
`POST /api/v1/conductor/webhooks/:workflowSlug` (mounted in `index.ts`, **outside** `requireAuth`
since callers are external), authenticated by a per-trigger shared secret / HMAC header (reusing
the channel SDK's `verify_signature` convention). The validated body becomes the run's initial
context via `startRun`. Net-new, small. (Distinct from the `event` trigger, which is internal
`ctx.events.emit`; the webhook trigger is for systems that cannot host a connector plugin.)

**J. `ctx.subAgent.ask` is stateless and uncycled.** One `ask()` = one full sub-agent run,
fresh messages array, returns only a final string, no cross-call session, **no indirect-cycle
detection** (A→B→A) beyond `maxIterations`. A multi-step process **must not** thread state
through `ctx.subAgent.ask`; the **run context** (persisted `conductor_runs.context`) is the
state carrier between steps, and the executor (not the sub-agent seam) owns ordering. Conductor
must add its own per-run cycle/budget accounting if agent steps can re-enter.

**K. Event-catalog resolve hook is dynamic-agents-only. (VERIFIED — confirmed fork.)** There are
**two parallel activation runtimes**, both driven from `index.ts`: `DynamicAgentRuntime`
(`dynamicAgentRuntime.ts`, dynamic/uploaded agents — **has** the `canvasOutputRegistry.register`
resolve hook at ~L520-545) and `ToolPluginRuntime` (`middleware/src/plugins/toolPluginRuntime.ts`
`activate()` L208-300, built-in/static tool/extension/integration packages — **NO** manifest-
capability resolve step; built-ins register tools directly into `nativeToolRegistry` from their own
`activate(ctx)`). A built-in connector declaring `emits:` is resolved by **nothing** today.
**Decision (RESOLVED)**: Conductor's `EventCatalogRegistry` resolve call must be added on **both**
paths — clone the dynamic-runtime block into `ToolPluginRuntime.activate()` (~L293, after
`this.active.set(...)`) and the symmetric `unregister` into its deactivate. Same applies to the
new `irreversible` resolve (§7-P). This is the single most overlooked wiring task.

**P. `irreversible` action flag is net-new. (VERIFIED.)** US8/FR-029 needs preview to stub
"connector actions flagged irreversible", but **no `irreversible`/`destructive`/side-effecting
capability flag exists** — the manifest capability schema (`admin-v1.ts` L278-287) has only
`provides`/`requires` strings plus exactly two per-capability booleans (`canvas_output`,
`deterministic_action`). **Decision (RESOLVED)**: add an `irreversible: true` per-capability boolean
following the `canvas_output` precedent — a new `irreversibleActionToolIds(manifest)` helper (clone
of `canvasOutputToolIds`, `canvasOutputRegistry.ts` L59) + an `IrreversibleActionRegistry`, resolved
on **both** activation paths (§7-K). The preview StepEffects (§6) consults it to stub the action.

**L. The single-agent canvas does not model a process.** `web-ui/app/admin/builder` +
`graphMapping.graphToFlow` are hard-coded to one `agent` node + its sub-agents/skills/tools
(`AgentGraph`). A conductor graph (peer steps, guarded transitions, triggers) needs a new
node-kind union, edge-semantics table, and persistence routes — a parallel canvas
implementation, not a config of the existing one.

**M. `deterministic_action` fast-path is canvas-UI-shaped.** The LLM-free dispatch
(`omadia-ui-orchestrator/src/plugin.ts` L442-480) requires a structured *canvas action* whose
`type` names an allow-set tool + a canvas-output sentinel. It is **not** a general "skip the LLM
for this step." A conductor `action` step that calls a connector action will invoke the bridged
tool handler directly (via `dynamicAgentRuntime.invokeAgentTool`, L644-652) — the right seam —
but should not be confused with the canvas fast-path.

**N. `buildOrchestrator` is test-only.** Use `buildOrchestratorForAgent`
(`buildOrchestrator.ts` L155); it owns a large `OrchestratorDeps` surface and the post-activate
`attachOrchestrator` handshake. Agent steps reuse the registry's already-built bundles rather
than constructing orchestrators ad hoc.

**O. Operator access is session-only (no RBAC role).** `requireAuth` = authenticated admin
session; there is no `role==='operator'` check and no Next-layer guard. Conductor routes must be
explicitly mounted behind `requireAuth` under `/api/v1/operator/conductors/*`; per-row ownership
(if any) is handler-enforced via `req.session`.

### Resolved decisions (owner sign-off 2026-06-17)

1. **conversationRef provisioning (§7-C)** → **new durable `conductor_channel_bindings` table**
   `(user_id, channel_type, conversation_ref JSONB)`, PK `(user_id, channel_type)`. Resolved at
   dispatch; a miss creates the await flagged `unreachable` and fires the workflow's configurable
   fallback transition (default). Decoupled from `routines`. (Phase 4 net-new sub-task.)
2. **Cron triggers** → **sibling `conductor_schedules` table** `(id, workflow_id FK, cron,
   timezone, status, last_run_at)`, polled by the same `ScheduleWorker.tick()`. No FK coupling to
   `agents`. (Phase 3.)
3. **Multi-replica posture** → **DB claim from day one**: due-row selection uses
   `FOR UPDATE SKIP LOCKED` + a `claimed_by`/`claimed_at` column on `conductor_awaits` (and the
   cron poll). Removes the in-memory-dedup footgun; horizontal scale-out becomes free. (Phases 2/4.)
4. **Guard/postcondition language** → **serializable predicate AST** over `{ctx, stepResult}`
   (`eq|and|or|not|exists|gt|lt|in|matches`), JSON-schema-validated, no `eval`. Keeps the engine
   pure (SC-009) and makes Designer field-autocomplete trivial from the payload schema. (Phase 1.)

---

## 8. Test Strategy (mapped to Success Criteria)

| SC | Test | Where |
|---|---|---|
| SC-009 | Determinism property/fixture test, no I/O | `conductor-core` vitest (Phase 1) |
| SC-001 | Build+save+run agentic+human workflow no-code | e2e (Phase 6) |
| SC-002 | Restart mid-wait → resume, no re-exec/skip | integration restart test (Phase 2) |
| SC-003 | Clock-driven reminder + deadline fallback, both quorum modes | await worker test (Phase 4) |
| SC-004 | Fixture connector `emits:` → catalog → selectable trigger | event-catalog test (Phase 3) |
| SC-005 | Schema-violating emit → no run + logged | event-router test (Phase 3) |
| SC-006 | Baton A→B → reminder target + await access transfer | role-resolver test (Phase 5) |
| SC-007 | No-holder role → fallback, no hang | role-resolver test (Phase 5) |
| SC-008 | Edit+resave → new version, in-flight run unchanged | versioning test (Phase 6) |
| SC-010 | Completed run trace completeness | audit test (Phase 8) |

Engine tests are pure/fixture-driven (mirror `canvas-core/test`). Kernel tests use the
`StepEffects` fakes + a test `graphPool` (or skip-on-no-pool, matching routines tests). Clock is
injected (`now?` dep already present on `ScheduleWorker`) for deterministic reminder/deadline
tests.

---

## 9. Migration & Rollout

- **DB**: `0001_conductor.sql` via `runConductorMigrations` (per-subsystem migrator, gated on
  `graphPool`). Forward-only, idempotent DDL.
- **Data-model deltas beyond `data-model.md`** (introduced by the resolved decisions; `data-model.md`
  is iret77's spec artifact and is left untouched — these land in the migration + a follow-up
  data-model update on the PR branch):
  - **`conductor_channel_bindings`** `(user_id UUID, channel_type TEXT, conversation_ref JSONB,
    PRIMARY KEY (user_id, channel_type))` — RESOLVED #1.
  - **`conductor_schedules`** `(id, workflow_id FK, cron TEXT, timezone TEXT, status, last_run_at)` —
    RESOLVED #2.
  - **`claimed_by UUID`, `claimed_at TIMESTAMPTZ`** columns on `conductor_awaits` (and
    `conductor_schedules`) for the `FOR UPDATE SKIP LOCKED` claim — RESOLVED #3.
  - **`unreachable` await flag** — a status/flag on `conductor_awaits` for the "principal
    unreachable on channel" edge case (RESOLVED #1).
  - **Manifest**: per-capability **`irreversible: true`** boolean (§7-P), alongside the
    `emits:` block + `permissions.events.emit` already in `data-model.md`.
- **Manifest**: `emits:` + `events_emit` permission are **additive** — existing manifests without
  them are unaffected (absence of `emits:` is meaningful, surfaced in the Designer per FR-014).
- **Feature gating**: Conductor inert without `graphPool`; Designer routes 503 when the conductor
  service is absent (mirror `operatorAgents` 503-on-missing-registry).
- **Backward compatibility**: no change to existing orchestrator/agent-builder behavior; Conductor
  is an additive process layer. `ask_user_choice` is untouched (Conductor's await is a separate
  substrate, not a replacement migration).

---

## 10. Phase → Story → Risk Summary

| Phase | Story (Priority) | Risk | Net-new? |
|---|---|---|---|
| 0 Foundations | — | low | scaffold |
| 1 Engine core | US1 (P1) | low | engine + AST |
| 2 Run lifecycle | US2 (P1) | **high** | executor + resume |
| 3 Triggers + events | US3+US4 (P1) | medium | event surface |
| 4 Human awaits | US5 (P1) | **high** | await + conversationRef |
| 5 Roles | US6 (P1) | medium | resolver seam |
| 6 Designer | US7 (P2) | medium | conductor canvas/toolset |
| 7 Preview | US8 (P2) | medium-high | multi-agent preview |
| 8 Audit | US9 (P3) | low | viewer layer |

**MVP cut** (delivers SC-001..SC-003, SC-009 — the headline): Phases 0–5 via API/config, before
the Designer. This matches the spec's "usable via API once US1–US6 land; Designer is the
ergonomics layer" framing.
