---
description: "Task list for the Multi-Orchestrator Runtime feature"
---

# Tasks: Multi-Orchestrator Runtime

**Input**: Design documents in `/specs/001-multi-orchestrator-runtime/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md,
contracts/plugin-lifecycle.md

**Tests**: Test tasks ARE included — the spec's Independent Tests and the Omadia
Constitution (§IV) make test-green plus per-step boot smoke tests a
non-negotiable gate.

**Organization**: Grouped by user story (US1–US9) so each ships as an
independently testable increment in priority order.

**Re-baseline note (2026-05-21)**: P1 was re-baselined — the platform already
has a plugin lifecycle (`activate`/`PluginContext`/`close`), so US1–US3 extend
the existing manifest and parameterize Orchestrator construction rather than
introducing a new contract or migrating plugins. See `spec.md`.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: may run in parallel (different files, no dependency)
- **[Story]**: owning user story
- File paths are repo-relative.

---

## Phase 1: Setup (Shared Infrastructure)

- [ ] T001 Confirm the Node 22.22.3 toolchain (`.nvmrc`), the
  `node --import tsx --test` runner, and ESLint resolve for `middleware/` and
  the affected workspace packages.

---

## Phase 2: Foundational (Blocking Prerequisites)

No standalone foundational tasks — US1 (the manifest extension) is itself the
small foundational P1 increment and carries its own phase below.

---

## Phase 3: User Story 1 - Plugin Manifest Declares Multi-Instance Safety (P1)

**Goal**: The existing plugin manifest carries `multiInstance` and
`privacyClass`, loaded and validated through the existing manifest path.

**Independent Test**: Load a `manifest.yaml` with the new fields; confirm they
reach the `Plugin` object and that `manifestLinter` rejects a
`multiInstance: false` manifest with no justification.

- [ ] T002 [US1] Extend the `Plugin` type with `multiInstance: boolean`,
  `multiInstanceJustification?: string`, and `privacyClass: 'strict' | 'default'`
  in `middleware/src/api/admin-v1.ts`.
- [ ] T003 [US1] Extend `adaptManifestV1()` in
  `middleware/src/plugins/manifestLoader.ts` to map the new `manifest.yaml`
  fields, defaulting `multiInstance` to `true` when absent.
- [ ] T004 [US1] Add validation for the new fields to
  `middleware/src/plugins/builder/manifestLinter.ts`: reject `multiInstance:
  false` without a non-empty `multiInstanceJustification`; reject an unknown
  `privacyClass`; name the failing field.
- [ ] T005 [US1] Test: load a `manifest.yaml` carrying the new fields and assert
  they reach the `Plugin` object (with the `multiInstance` default); assert the
  linter rejects an invalid multi-instance / privacy declaration with a precise
  error.

**Checkpoint**: The manifest carries multi-instance safety — US2 and US4 can
consume it.

---

## Phase 4: User Story 2 - Agent Builder Emits the Multi-Instance Manifest Fields (P1)

**Goal**: Builder-generated plugins declare `multiInstance` and `privacyClass`.

**Independent Test**: Generate a plugin from the Builder; confirm its
`manifest.yaml` carries the new fields and passes `manifestLinter`.

- [ ] T006 [P] [US2] Add `multiInstance` and `privacyClass` to the Builder
  boilerplate manifests under `middleware/assets/boilerplate/*/manifest.yaml`.
- [ ] T007 [US2] Update the Builder codegen
  (`middleware/src/plugins/builder/codegen.ts`) so every generated
  `manifest.yaml` emits `multiInstance` and `privacyClass`.
- [ ] T008 [US2] Expose `multiInstance` (with a justification field required
  when it is `false`) and `privacyClass` in the Builder's manifest step / UI.
- [ ] T009 [US2] Test: generate a plugin from the Builder; assert its
  `manifest.yaml` carries the new fields and passes `manifestLinter`. Boot smoke
  test: load the generated plugin into a dev orchestrator and confirm it
  activates clean (Constitution IV).

**Checkpoint**: New Builder output is registry-ready by construction.

---

## Phase 5: User Story 3 - Orchestrator Construction Is Per-Agent Parameterizable (P1)

**Goal**: An `Orchestrator` can be constructed for a named Agent, not just once
process-globally.

**Independent Test**: Call the construction function twice with two Agent
configs; confirm two independent `Orchestrator` instances; single-Agent
behaviour unchanged when called once.

- [ ] T010 [US3] Extract `Orchestrator` construction in
  `middleware/packages/harness-orchestrator/src/plugin.ts` and
  `src/orchestrator.ts` into a function parameterized by an Agent config (id,
  plugin/tool set, privacy profile) — not a process-global build.
- [ ] T011 [US3] Make the orchestrator plugin's `activate()` call the new
  function once for the default Agent, so current single-orchestrator behaviour
  is unchanged.
- [ ] T012 [US3] Test: call the construction function twice with two Agent
  configs → two independent `Orchestrator` instances with disjoint tool sets and
  no shared mutable state; run the existing orchestrator suite and a boot smoke
  test, confirm no single-Agent regression.

**Checkpoint**: The structural unlock for US4 is in place.

---

## Phase 6: User Story 4 - Multiple Orchestrators from Operator Config (P1) 🎯 MVP

**Goal**: Two+ isolated Agents run in one process from DB config (restart-based
apply at this stage).

**Independent Test**: Two-Agent config; each responds with only its own plugin
set; cross-Agent plugin access is impossible.

- [ ] T013 [US4] Migration: `agents`, `agent_plugins`, `channel_bindings`,
  `platform_settings` tables + the `notify_agents_changed` trigger, in
  `middleware/migrations/`.
- [ ] T014 [US4] Implement `configStore` (read/write of the four tables) in
  `middleware/packages/harness-orchestrator/src/registry/configStore.ts`.
- [ ] T015 [US4] Implement `OrchestratorRegistry` — build N `Orchestrator`
  instances from config, each activating its own plugin set against per-Agent
  `PluginContext`s — in `harness-orchestrator/src/registry/`.
- [ ] T016 [US4] Enforce config validation: unique channel keys,
  `multiInstance: false` single-assignment, satisfiable plugin permissions.
- [ ] T017 [P] [US4] CLI `agents:apply` to load/refresh config from the DB for
  local E2E.
- [ ] T018 [US4] Isolate runtime plugin errors during a turn so a throw in one
  Agent never crashes the process or degrades another Agent (FR-009, SC-007).
- [ ] T019 [US4] Test: two-Agent config; assert isolation (US4 acceptance
  scenarios 1–4, SC-007). Boot smoke test: start the platform with both Agents
  (dev server + log monitor + one request per Agent).

**Checkpoint**: 🎯 MVP — multiple orchestrators exist and are demonstrable.

---

## Phase 7: User Story 5 - Hot-Reload Without Infrastructure Restart (P2)

**Goal**: Config changes apply live, no process restart, zero downtime for
unrelated Agents.

**Independent Test**: Change Agent B's plugins while Agent A serves; PID
unchanged; Agent A untouched.

- [ ] T020 [US5] Implement `applyDiff(oldCfg, newCfg)` (add/remove Agent,
  attach/detach plugin via `activate`/`close`, re-activate on config change,
  swap binding) in `harness-orchestrator/src/registry/`; emit a structured log
  on every diff action (`agentId`, `pluginId` — FR-020, Constitution VI).
- [ ] T021 [US5] Implement `reloadBus.ts`: Postgres `LISTEN agents_changed` +
  periodic reconcile fallback; log every notification and reconcile pass
  (FR-020).
- [ ] T022 [US5] Isolate `activate`/`close` failures in `applyDiff` (catch, log
  with `agentId`+`pluginId`, continue).
- [ ] T023 [US5] Test: hot add/remove Agent + plugin; assert PID stable, other
  Agents zero-downtime (SC-001, SC-002), a throwing `close()` isolated. Boot
  smoke test: apply a live change against a running dev server, confirm via the
  log monitor + a request.

**Checkpoint**: Live reconfiguration works across all machines.

---

## Phase 8: User Story 6 - In-Flight Sessions Never Disrupted (P2)

**Goal**: Running sessions keep their start-time config snapshot.

**Independent Test**: Snapshot a session's tool set; change Agent config;
session tool set unchanged; new session sees the change.

- [ ] T024 [US6] Add `ConfigSnapshot` capture at session start in
  `harness-orchestrator/src/chatSessionStore.ts`.
- [ ] T025 [US6] Make turn execution read plugins / tools / memory scope from
  the session snapshot, not the live registry.
- [ ] T026 [US6] Implement the two-mode `force-invalidate` action — `drain`
  (let the in-flight turn finish, bounded by the per-turn timeout, escalating to
  `kill` on overrun, then re-bind the session, keep its history) and `kill` (end
  sessions immediately, discard the session-store entry); emit a structured log
  per invocation (`agentId`, `mode`, `sessionId` — FR-020).
- [ ] T027 [US6] Test: SC-006 — in-flight tool set immutable under config
  change; new session reflects change; `drain` re-binds keeping history, `kill`
  ends the session and discards its store entry. Boot smoke test: exercise a
  live session on a running dev server across a reload.

**Checkpoint**: Hot-reload is safe for live conversations.

---

## Phase 9: User Story 7 - Channel Routing to the Correct Orchestrator (P2)

**Goal**: Inbound webhooks reach the Agent that owns the channel binding.

**Independent Test**: Two bindings → two Agents; each webhook handled by the
intended Agent.

- [ ] T028 [US7] Implement `channelResolver.ts` (channel type + key → Agent via
  the live registry) in `harness-orchestrator/src/routing/`; log every routing
  decision with structured context (`channelKey`, resolved `agentId` — FR-020).
- [ ] T029 [US7] First-boot onboarding seeds a minimal-privilege fallback Agent
  (zero plugins, `strict` privacy profile) and sets
  `platform_settings.fallback_agent_id` to it (FR-021, C2).
- [ ] T030 [US7] Wire the static webhook handlers (`/api/teams/messages`,
  Telegram) through the resolver.
- [ ] T031 [US7] Handle unmatched keys: route to
  `platform_settings.fallback_agent_id` when set, hard-reject when unset, always
  logged (FR-015).
- [ ] T032 [US7] Test: SC-008 — correct routing for bound keys; unmatched keys
  route to the fallback Agent when configured and hard-reject + log when not;
  binding-move finishes in-flight on the old Agent. Boot smoke test: deliver a
  real webhook per binding against a running dev server.

**Checkpoint**: Public vs. general channel split is live for end users.

---

## Phase 10: User Story 8 - Memory Visibility Scoped by Enabled Plugins (P3)

**Goal**: An Agent reads/writes only its plugins' `permissions.memory` scopes ∪
`core`.

**Independent Test**: Public Agent with Confluence but not Odoo-HR reads
Confluence memory, cannot read Odoo-HR memory.

- [ ] T033 [US8] Compute an Agent's memory scope as the union of its enabled
  plugins' `permissions.memory` declarations plus `core`, in scope construction.
- [ ] T034 [US8] Make `harness-memory` read/write filter by the Agent's memory
  scope; tag writes with the originating plugin.
- [ ] T035 [US8] Include the memory scope in the session `ConfigSnapshot`
  (pinned per US6).
- [ ] T036 [US8] Test: SC-003 — public vs. general memory isolation;
  cross-Agent shared-plugin read; removed-plugin entry persists but invisible.

**Checkpoint**: Privacy-by-capability enforced for memory.

---

## Phase 11: User Story 9 - Operator UI to Create and Manage Agents (P3)

**Goal**: An "Agents" dashboard tab for Agent CRUD + inspection.

**Independent Test**: Create an Agent via UI with plugins + binding; it appears,
serves, and reflects edits/disable.

- [ ] T037 [US9] Backend: REST endpoints for Agent CRUD + channel bindings over
  `configStore` (server-side validation per FR-016, FR-008).
- [ ] T038 [US9] Add the "Agents" tab to the `web-ui` dashboard via the
  plugin-UI platform (`harness-ui-helpers`).
- [ ] T039 [US9] Build the create-Agent wizard (identity → plugins → channels →
  privacy profile).
- [ ] T040 [P] [US9] Plugin multi-select shows multi-instance compatibility +
  memory scopes from the manifest.
- [ ] T041 [P] [US9] Per-Agent running-session count + "drain & reload" action.
- [ ] T042 [US9] Test: UI create/edit/disable round-trips via hot-reload (US9
  acceptance scenarios 1–5). Boot smoke test: drive the create/edit/disable flow
  in a browser against a running dev server (dev server + log monitor).

**Checkpoint**: Operator self-service complete.

---

## Phase 12: Polish & Cross-Cutting Concerns

- [ ] T043 [P] Verify structured-logging coverage across lifecycle, routing, and
  reload seams — each seam task above emits its logs inline (FR-020,
  Constitution VI); this is the final cross-cutting check.
- [ ] T044 [P] Update `docs/` + Notion architecture subpages for the
  multi-orchestrator runtime.
- [ ] T045 Boot smoke test covering the full public-vs-general two-Agent
  deployment shape.
- [ ] T046 Run quickstart validation end-to-end; confirm all Success Criteria
  SC-001…SC-008.

---

## Dependencies & Execution Order

### Phase / Story dependencies

- **Setup → US1–US9**: Setup first.
- **US1** (manifest extension) blocks **US2** (Builder emits the fields) and is
  consumed by **US4** (registry reads `multiInstance`).
- **US3** (per-Agent Orchestrator construction) is independent of US1/US2 and
  blocks **US4** — it is the structural unlock.
- **US4** blocks **US5, US6, US7** (all need the registry).
- **US5 + US6** are paired — hot-reload (US5) is unsafe without snapshot pinning
  (US6); deliver together.
- **US7** depends on US4; independent of US5/US6.
- **US8** depends on US4 (registry) and US3 (per-Agent scope).
- **US9** depends on US4 (config store) and US5 (hot-reload for live apply).

### Priority cascade

- **P1 (MVP)**: (US1 → US2) ∥ US3 → US4 — multiple orchestrators from config.
- **P2**: US5 ∥ US6 → US7 — live reconfiguration + routing.
- **P3**: US8 → US9 — privacy-by-capability + operator UI.

### Parallel opportunities

- US1/US3 are independent — parallel; US2 starts once US1 lands.
- T006 (boilerplate) is independent of T007/T008.
- Within P2, US5/US6 (one team) and US7 (another) can proceed in parallel.

## Implementation Strategy

1. **MVP first**: Setup → (US1 → US2) ∥ US3 → US4. Stop, validate two isolated
   orchestrators, demo.
2. **Increment 2**: US5 ∥ US6 → US7. Validate live reload + routing, demo.
3. **Increment 3**: US8 → US9. Validate privacy-by-capability + UI, demo.
4. Each increment is independently deployable and leaves the platform green.
