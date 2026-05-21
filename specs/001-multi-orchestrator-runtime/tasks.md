---
description: "Task list for the Multi-Orchestrator Runtime feature"
---

# Tasks: Multi-Orchestrator Runtime

**Input**: Design documents in `/specs/001-multi-orchestrator-runtime/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md,
contracts/plugin-lifecycle.md

**Tests**: Test tasks ARE included — the spec and the Omadia Constitution make
test-green a non-negotiable gate (dispose-roundtrip, builder-ready gate, SC
verification, boot smoke tests).

**Organization**: Grouped by user story (US1–US9) so each ships as an
independently testable increment in priority order.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: may run in parallel (different files, no dependency)
- **[Story]**: owning user story
- File paths are repo-relative.

---

## Phase 1: Setup (Shared Infrastructure)

- [ ] T001 Create the `plugin-api` package skeleton at
  `middleware/packages/plugin-api/` (package.json, tsconfig, build wiring into
  the npm workspace).
- [ ] T002 [P] Add the migrations directory + runner convention check under
  `middleware/migrations/` if not already present.
- [ ] T003 [P] Confirm Node 22.12.0 toolchain (`.nvmrc`), Node's native test
  runner (`node --import tsx --test`), and ESLint config resolve for the
  `plugin-api` package.

---

## Phase 2: Foundational (Blocking Prerequisites)

**⚠️ CRITICAL**: US1 is the blocking prerequisite — US2–US9 cannot start until
the `plugin-api` contract is published.

- [ ] T004 Decide and document the capability-name vocabulary (`llm:chat`,
  `kg:read`, `memory:rw`, …) referenced by `requiredCapabilities`, in
  `specs/001-multi-orchestrator-runtime/contracts/`.

**Checkpoint**: Capability vocabulary fixed — US1 can be authored against it.

---

## Phase 3: User Story 1 - Frozen Plugin Lifecycle Contract (P1) 🎯 MVP foundation

**Goal**: One authoritative `plugin-api` contract for plugin lifecycle + manifest.

**Independent Test**: Compile `plugin-api`; type-check a trivial reference
plugin against `Plugin`/`PluginScope`; validate a manifest against the schema.

- [ ] T005 [US1] Implement `Plugin`, `PluginScope`, `Disposable`, `ScopeLogger`
  in `middleware/packages/plugin-api/src/lifecycle.ts` per
  `contracts/plugin-lifecycle.md`.
- [ ] T006 [P] [US1] Implement the extended `PluginManifest` type in
  `middleware/packages/plugin-api/src/manifest.ts`.
- [ ] T007 [P] [US1] Add `manifest.schema.json` (incl. the
  `multiInstance:false ⇒ justification` conditional) at
  `middleware/packages/plugin-api/schemas/manifest.schema.json`.
- [ ] T008 [US1] Export the public surface from
  `middleware/packages/plugin-api/src/index.ts`.
- [ ] T009 [US1] Test: type-check a reference plugin against the contract; run
  manifest-schema validation for valid + invalid manifests (missing required
  fields, `multiInstance:false` without justification).

**Checkpoint**: Contract published — US2–US9 may begin. ⚠️ Notify the Agent
Builder worktree immediately (US2 is time-critical).

---

## Phase 4: User Story 2 - Agent Builder Produces Multi-Orchestrator-Ready Plugins (P1)

**Goal**: Builder scaffolds satisfy the contract by construction; a four-check
gate blocks non-compliant plugins.

**Independent Test**: Generate a fresh plugin; run the builder-ready gate; all
four checks pass and the `dispose-roundtrip` test is present and green.

- [ ] T010 [US2] Update Builder plugin templates to emit `init`/`dispose`
  scaffolding and scope-based service resolution (no module-scope state).
- [ ] T011 [P] [US2] Add the mandatory generated `dispose-roundtrip` test
  template per `contracts/plugin-lifecycle.md` §4.
- [ ] T012 [P] [US2] Implement the custom ESLint rule `no-module-state` and
  wire it into the Builder template lint config.
- [ ] T013 [US2] Implement the builder-ready gate (4 checks: tsc-contract,
  no-module-state, dispose-roundtrip, manifest-schema) as a CI step + a
  Builder-invoked check.
- [ ] T014 [US2] Wire the gate result into the Builder UI: disable publish on
  failure, name the failing check.
- [ ] T015 [P] [US2] Add manifest-wizard fields to the Builder UI
  (`multiInstance`, `memoryNamespaces`, `privacyClass`, `requiredCapabilities`);
  default `privacyClass` to `strict`.
- [ ] T016 [US2] Test: generate a plugin and assert all four gate checks pass;
  inject a module-level `let` and assert the gate fails with `no-module-state`.
  Boot smoke test: load the generated plugin into a dev orchestrator and confirm
  its `init` runs clean (Constitution IV).

**Checkpoint**: Builder output is multi-orchestrator-ready by construction.

---

## Phase 5: User Story 3 - Existing Plugins Migrated to the Lifecycle Contract (P1)

**Goal**: All ~22 existing plugins implement `init`/`dispose`; no module-scope
state; no behavioural change.

**Independent Test**: Per plugin, `dispose-roundtrip` is green; full middleware
suite stays green.

- [ ] T017 [US3] Audit every plugin under
  `middleware/packages/{harness-channel-*,harness-integration-*,agent-*,harness-plugin-*}`
  for module-scope state; record findings as a per-plugin checklist.
- [ ] T018 [P] [US3] Migrate `harness-channel-teams` to `init`/`dispose`
  (webhook subscriptions, clients into scope).
- [ ] T019 [P] [US3] Migrate `harness-channel-telegram` (long-poll loop into
  scope).
- [ ] T020 [P] [US3] Migrate `harness-integration-microsoft365` (GraphClient
  token-refresh timer + token cache into scope).
- [ ] T021 [P] [US3] Migrate `harness-integration-odoo`.
- [ ] T022 [P] [US3] Migrate `harness-integration-confluence`.
- [ ] T023 [P] [US3] Migrate the `agent-*` plugins (odoo-hr, odoo-accounting,
  confluence, seo-analyst, reference-maximum).
- [ ] T024 [P] [US3] Migrate the `harness-plugin-*` plugins (privacy-detector
  ×2, privacy-guard, quality-guard, web-search).
- [ ] T025 [US3] Add a `dispose-roundtrip` test to every migrated plugin.
- [ ] T026 [US3] Run the full middleware suite + a boot smoke test; confirm zero
  behavioural regression.

**Checkpoint**: Every plugin honours the contract — the registry can
instantiate plugins per-Agent.

---

## Phase 6: User Story 4 - Multiple Orchestrators from Operator Config (P1)

**Goal**: Two+ isolated Agents run in one process from DB config (restart-based
apply at this stage).

**Independent Test**: Two-Agent config; each responds with only its own plugin
set; cross-Agent plugin access is impossible.

- [ ] T027 [US4] Migration: `agents`, `agent_plugins`, `channel_bindings`
  tables + the `notify_agents_changed` trigger, in `middleware/migrations/`.
- [ ] T028 [US4] Implement `configStore.ts` (read/write of the three tables) in
  `middleware/packages/harness-orchestrator/src/registry/`.
- [ ] T029 [US4] Implement `PluginScope` construction (services populated from
  `requiredCapabilities`) in
  `middleware/packages/harness-orchestrator/src/pluginScope.ts`.
- [ ] T030 [US4] Implement `OrchestratorRegistry` (build N `Orchestrator`
  instances from config; per-Agent scope sets) in
  `middleware/packages/harness-orchestrator/src/registry/`.
- [ ] T031 [US4] Refactor `Orchestrator` to consume an injected scope set
  instead of process-global plugin wiring (`src/orchestrator.ts`,
  `OrchestratorOptions`); isolate runtime plugin errors during a turn so a throw
  in one Agent never crashes the process or degrades another Agent (FR-009,
  SC-007).
- [ ] T032 [US4] Enforce config validation: unique channel keys,
  `multiInstance:false` single-assignment, satisfiable capabilities.
- [ ] T033 [P] [US4] CLI `agents:apply` to load/refresh config from DB for
  local E2E.
- [ ] T034 [US4] Test: two-Agent config; assert isolation (US4 acceptance
  scenarios 1–4, SC-007 plugin-failure isolation). Boot smoke test: start the
  platform with both Agents (dev server + log monitor + one request per Agent).

**Checkpoint**: 🎯 MVP — multiple orchestrators exist and are demonstrable.

---

## Phase 7: User Story 5 - Hot-Reload Without Infrastructure Restart (P2)

**Goal**: Config changes apply live, no process restart, zero downtime for
unrelated Agents.

**Independent Test**: Change Agent B's plugins while Agent A serves; PID
unchanged; Agent A untouched.

- [ ] T035 [US5] Implement `applyDiff(oldCfg, newCfg)` (add/remove Agent,
  attach/detach plugin, reconfigure, swap binding) in
  `harness-orchestrator/src/registry/`; emit a structured log on every diff
  action (`agentId`, `pluginId` — FR-020, Constitution VI).
- [ ] T036 [US5] Implement `reloadBus.ts`: Postgres `LISTEN agents_changed` +
  periodic reconcile fallback; log every notification and reconcile pass with
  structured context (FR-020).
- [ ] T037 [US5] Isolate `init`/`dispose` failures in `applyDiff` (catch, log
  with `agentId`+`pluginId`, continue).
- [ ] T038 [US5] Test: hot add/remove Agent + plugin; assert PID stable, other
  Agents zero-downtime (SC-001, SC-002), throwing `dispose` isolated. Boot smoke
  test: apply a live change against a running dev server, confirm via the log
  monitor + a request.

**Checkpoint**: Live reconfiguration works across all machines.

---

## Phase 8: User Story 6 - In-Flight Sessions Never Disrupted (P2)

**Goal**: Running sessions keep their start-time config snapshot.

**Independent Test**: Snapshot a session's tool set; change Agent config;
session tool set unchanged; new session sees the change.

- [ ] T039 [US6] Add `ConfigSnapshot` capture at session start in
  `harness-orchestrator/src/chatSessionStore.ts`.
- [ ] T040 [US6] Make turn execution read plugins/tools/namespaces from the
  session snapshot, not the live registry.
- [ ] T041 [US6] Implement the two-mode `force-invalidate` endpoint/action —
  `drain` (let the in-flight turn finish — bounded by the per-turn timeout,
  escalating to `kill` on overrun — then re-bind the session, keep its history)
  and `kill` (end sessions immediately, discard the session-store entry); emit a
  structured log per invocation (`agentId`, `mode`, `sessionId` — FR-020).
- [ ] T042 [US6] Test: SC-006 — in-flight tool set immutable under config
  change; new session reflects change; `force-invalidate` `drain` re-binds and
  keeps history, `kill` ends the session and discards its store entry. Boot
  smoke test: exercise a live session on a running dev server across a reload.

**Checkpoint**: Hot-reload is safe for live conversations.

---

## Phase 9: User Story 7 - Channel Routing to the Correct Orchestrator (P2)

**Goal**: Inbound webhooks reach the Agent that owns the channel binding.

**Independent Test**: Two bindings → two Agents; each webhook handled by the
intended Agent.

- [ ] T043 [US7] Implement `channelResolver.ts` (channel type + key → Agent via
  live registry) in `harness-orchestrator/src/routing/`; log every routing
  decision with structured context (`channelKey`, resolved `agentId` — FR-020).
- [ ] T044 [US7] Migration: `platform_settings` table (single-row,
  `fallback_agent_id`) + its dedicated `agents_changed` trigger, in
  `middleware/migrations/`; extend `configStore` to read it. First-boot
  onboarding seeds a minimal-privilege fallback Agent (zero plugins, `strict`
  profile) and points `fallback_agent_id` at it (C2; FR-021).
- [ ] T045 [US7] Wire the static webhook handlers (`/api/teams/messages`,
  Telegram) through the resolver.
- [ ] T046 [US7] Handle unmatched keys in the resolver: route to
  `platform_settings.fallback_agent_id` when set, hard-reject when unset, always
  logged (FR-015, C2).
- [ ] T047 [US7] Test: SC-008 — correct routing for bound keys; unmatched keys
  route to the fallback Agent when one is configured and hard-reject + log when
  not; binding-move finishes in-flight on old Agent. Boot smoke test: deliver a
  real webhook per binding against a running dev server.

**Checkpoint**: Public vs. general channel split is live for end users.

---

## Phase 10: User Story 8 - Memory Visibility Scoped by Enabled Plugins (P3)

**Goal**: An Agent reads/writes only its plugins' namespaces ∪ `core`.

**Independent Test**: Public Agent with Confluence but not Odoo-HR reads
Confluence memory, cannot read Odoo-HR memory.

- [ ] T048 [US8] Consume `memoryNamespaces` from manifests; compute an Agent's
  visible-namespace union in scope construction.
- [ ] T049 [US8] Make `harness-memory` read/write filter by the scope's
  namespace set; tag writes with origin plugin.
- [ ] T050 [US8] Include `memoryNamespaces` in the session `ConfigSnapshot`
  (pinned per US6).
- [ ] T051 [US8] Test: SC-003 — public vs. general namespace isolation;
  cross-Agent shared-plugin read; removed-plugin entry persists but invisible.

**Checkpoint**: Privacy-by-capability enforced for memory.

---

## Phase 11: User Story 9 - Operator UI to Create and Manage Agents (P3)

**Goal**: An "Agents" dashboard tab for Agent CRUD + inspection.

**Independent Test**: Create an Agent via UI with plugins + binding; it appears,
serves, and reflects edits/disable.

- [ ] T052 [US9] Backend: REST endpoints for Agent CRUD + channel bindings over
  `configStore` (server-side validation per FR-016, FR-008).
- [ ] T053 [US9] Add the "Agents" tab to the `web-ui` dashboard via the
  plugin-UI platform (`harness-ui-helpers`).
- [ ] T054 [US9] Build the create-Agent wizard (identity → plugins → channels →
  privacy profile).
- [ ] T055 [P] [US9] Plugin multi-select shows multi-instance compatibility +
  `memoryNamespaces` from the manifest.
- [ ] T056 [P] [US9] Per-Agent running-session count + "drain & reload" action.
- [ ] T057 [US9] Test: UI create/edit/disable round-trips via hot-reload (US9
  acceptance scenarios 1–5). Boot smoke test: drive the create/edit/disable flow
  in a browser against a running dev server (dev server + log monitor).

**Checkpoint**: Operator self-service complete.

---

## Phase 12: Polish & Cross-Cutting Concerns

- [ ] T058 [P] Verify structured-logging coverage across lifecycle, routing, and
  reload seams — each seam task above emits its logs inline (FR-020,
  Constitution VI); this task is the final cross-cutting check, not where
  logging is first added.
- [ ] T059 [P] Update `docs/` + Notion architecture subpages for the
  multi-orchestrator runtime.
- [ ] T060 Boot smoke test covering the full public-vs-general two-Agent
  deployment shape.
- [ ] T061 Run quickstart validation end-to-end; confirm all Success Criteria
  SC-001…SC-008.

---

## Dependencies & Execution Order

### Phase / Story dependencies

- **Setup (P1) → Foundational (P2) → US1**: strictly sequential.
- **US1 blocks US2–US9** — nothing starts until the `plugin-api` contract is
  published.
- **US2** (Builder) is time-critical: start immediately after US1, in parallel
  with US3.
- **US3** (plugin migration) blocks **US4** (registry needs compliant plugins).
- **US4** blocks **US5, US6, US7** (all need the registry).
- **US5 + US6** are paired — hot-reload (US5) is unsafe without snapshot
  pinning (US6); deliver together.
- **US7** depends on US4; independent of US5/US6.
- **US8** depends on US4 (scope) and US3 (manifests); benefits from US6 pinning.
- **US9** depends on US4 (config store) and US5 (hot-reload for live apply).

### Priority cascade

- **P1 (MVP)**: US1 → US2 ∥ US3 → US4 — multiple orchestrators from config.
- **P2**: US5 ∥ US6 → US7 — live reconfiguration + routing.
- **P3**: US8 → US9 — privacy-by-capability + operator UI.

### Parallel opportunities

- T005–T007 (US1 contract files) are independent — parallel.
- T018–T024 (per-plugin migrations) are different packages — parallel.
- US2 and US3 run in parallel once US1 ships (different worktrees).
- Within P2, US5/US6 (one team) and US7 (another) can proceed in parallel.

## Implementation Strategy

1. **MVP first**: Setup → Foundational → US1 → US2 ∥ US3 → US4. Stop, validate
   two isolated orchestrators, demo.
2. **Increment 2**: US5 ∥ US6 → US7. Validate live reload + routing, demo.
3. **Increment 3**: US8 → US9. Validate privacy-by-capability + UI, demo.
4. Each increment is independently deployable and leaves the platform green.
