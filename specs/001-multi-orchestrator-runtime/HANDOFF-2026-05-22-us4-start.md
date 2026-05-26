# HANDOFF — Multi-Orchestrator Runtime · ready to start US4 (MVP)

**Date**: 2026-05-22
**Worktree**: `~/sources/odoo-bot-multi-orchestrator`
**Branch**: `001-multi-orchestrator-runtime` (off `main` @ `483ff18`)
**Status**: P1 complete (US1–US3 + re-baseline). **Next: US4 (MVP).**

Read this **after** `START-HERE.md`; this file is the resume-from-here for a
fresh session.

---

## Where we are

P1 of the feature is done and verified. The MVP (US4 — multiple
orchestrators from operator config) is the next focused unit of work and is
the headline capability of the feature.

### Commit chain on `001-multi-orchestrator-runtime`

```
9662377  feat(builder): US2 — emit + validate multi_instance / privacy_class
e6e8eb0  feat(orchestrator): US3 — parameterize Orchestrator construction per Agent
fc94248  feat(plugins): US1 — plugin manifest multi-instance + privacy class
5f2508e  docs(specs): fix /speckit-analyze findings I1-I3
ee326a3  docs(specs): re-baseline P1 against the existing plugin lifecycle
9202bf2  fix(middleware): bump Node pin to 22.22.3 to satisfy eslint engine reqs
37da964  revert(plugin-api): drop the redundant US1 lifecycle contract
50de6e5  feat(plugin-api): freeze the plugin lifecycle + manifest contract (US1)   [REVERTED]
e28bae3  docs(specs): resolve multi-orchestrator clarifications + analyze findings
88252fa  docs(specs): add multi-orchestrator runtime spec package
```

The `50de6e5 → 37da964` pair documents the honest re-baseline: a US1 contract
was authored, then reverted as redundant once codebase verification revealed
the platform already has the lifecycle (`activate`/`PluginContext`/`close`).

### What is true now (P1 done)

- **US1 (`fc94248`)** — `Plugin` type (`admin-v1.ts`) + `adaptManifestV1`
  (`manifestLoader.ts`) carry `multi_instance`, `multi_instance_justification?`,
  `privacy_class`; loader defaults permissively and warns on bad input.
- **US2 (`9662377`)** — `AgentSpecSchema` (Zod), `AgentSpecSkeleton`,
  `emptyAgentSpec`, `codegen.ts` (`doc.set(...)`), `manifestLinter.ts` (two
  new `ViolationKind`s), and both boilerplate `manifest.yaml` files carry the
  fields. The Builder emits them in every generated plugin.
- **US3 (`e6e8eb0`)** — `buildOrchestratorForAgent(config, deps)` extracted
  into `harness-orchestrator/src/buildOrchestrator.ts`. `Orchestrator` /
  `OrchestratorOptions` carry an optional `agentId` (default `'default'`).
  `plugin.ts` `activate()` calls the factory once for the default Agent;
  single-Agent behaviour is byte-identical.

### Spec package state

`spec.md` Status = **Ready**, 21 FRs, 8 SCs, 9 user stories.
`tasks.md` = **46 tasks** (T001–T046).
P1 done = T001..T012. **MVP = T013..T019 (US4)** is next.

All design docs (spec, plan, research, data-model, contracts/plugin-lifecycle,
START-HERE, tasks) are aligned with the re-baselined reality.

---

## The reality the spec was re-baselined against

Three premise corrections you must keep in mind:

1. **The plugin lifecycle already exists.** Every plugin already exports
   `activate(ctx: PluginContext): Promise<Handle>` with `handle.close()`.
   `PluginContext` (`middleware/packages/plugin-api/src/pluginContext.ts`)
   provides `agentId`, `domain`, capability-gated optional accessors
   (`memory?`, `llm?`, `http?`, `knowledgeGraph?`, `subAgent?` — present iff
   the manifest declares the permission), `services.{provide,get}`, `jobs`,
   `tools`, `routes`, `notifications`, `log()`. **There is no new lifecycle
   contract; do not invent one.**

2. **Manifest field names are snake_case.** Top-level `manifest.yaml` keys
   are `schema_version`, `depends_on`, `is_reference_only`, `admin_ui_path`
   — and now `multi_instance`, `multi_instance_justification`, `privacy_class`.
   The spec uses camelCase logical names in prose; YAML/`Plugin` type are
   snake_case.

3. **Test framework is Node's native runner.** `node --import tsx --test
   --test-reporter=spec 'test/**/*.test.ts'` — NOT vitest. (`harness-ui-helpers`
   is the lone vitest exception, for React reasons.)

The re-baselined design docs document all three; if you find prose that
contradicts, treat the docs as source of truth and edit the prose.

---

## Conventions to follow

- **Node**: `.nvmrc` (both root + `middleware/`) → `22.22.3`. Repo `engines:
  >=22.13.0 <23`. `npm install` works clean on 22.13+; on 22.12 use
  `--engine-strict=false` (the original symptom that drove `9202bf2`).
- **Native ABI**: `NODE_MODULE_VERSION 127` (Node 22.x). `check-node-version.mjs`
  asserts ABI 127. A Node-24 bump is a separate ticket.
- **Tests**: `node --import tsx --test test/<file>.test.ts` from
  `middleware/`. Tests live in `middleware/test/**/*.test.ts`.
- **TypeScript**: `^6.0.2`, strict, NodeNext, `.js` import extensions for
  local sources.
- **Lint**: `npx eslint <files>` from `middleware/`; `lint:fix` after changes.
- **Commits**: conventional, `Co-Authored-By: Claude Opus 4.7 (1M context)
  <noreply@anthropic.com>` trailer (matches repo style). NO "Generated with
  Claude Code" footer (user instruction). Always commit with **explicit
  pathspec** (`git commit -m "..." -- <paths>`) — Marcel's `.claude/CLAUDE.md`
  feedback memory documents why.
- **`CLAUDE.local.md`** at the worktree root is gitignored; it is *not*
  shared between worktrees. Already present and carrying the byte5 / single-
  repo setup. Keep it.
- **`docs/harness-platform/`** is gitignored (session context, HANDOFFs); the
  `specs/001-multi-orchestrator-runtime/` package — including this handoff —
  IS tracked.

---

## Sandbox limits worth knowing

- **`nvm install`** fails — read-only `/.cache`, no Node binary download or
  source build. Existing `node_modules` (installed via
  `--engine-strict=false`) is enough for typecheck + tests. The bumped
  `.nvmrc` is for the user's real machine + CI.
- **No browser / no real API calls** — tests use fakes (`{} as KnowledgeGraph`,
  `InMemoryNudgeRegistry`, `new Anthropic({apiKey:'test-key'})`).
- **Workspace packages must be built** for typecheck/test to resolve
  `@omadia/*` imports. Run `npm run build` at `middleware/` once per fresh
  worktree (builds all 18 packages). After that, `tsc --noEmit` and
  `node --test` work directly.

---

## How to verify a change in this codebase

The Constitution IV per-step boot-smoke ideal isn't reachable for pure-types
or per-package changes; the practical recipe used in P1:

1. `cd middleware && npx tsc --noEmit` — middleware/src typecheck (also
   covers `test/` via root tsconfig).
2. `npm run build -w <package>` — when the change is inside a
   `middleware/packages/<x>` package, build that package so downstream src /
   tests can resolve its `dist/`.
3. `node --import tsx --test --test-reporter=spec test/<file>.test.ts` — the
   new feature test.
4. `node --import tsx --test --test-reporter=spec 'test/<related-dir>/**/*.test.ts'`
   — regression sweep over the directly-affected area.
5. `npx eslint <changed-src-files>` — per the user's `lint:fix` rule.

Track verification numbers in commit messages (X/Y pass).

---

## US4 — the MVP — concrete plan

US4 builds the multi-orchestrator registry that turns the US3 factory into N
live Agents from operator config. **All seven tasks (T013–T019) land
together**; the deliverable is "two-Agent config produces two isolated,
demonstrable orchestrators."

### T013 — Migration

`middleware/migrations/0001_multi_orchestrator.sql` (first real migration in
this dir; `README.md` already documents the convention). Tables per
`data-model.md`:

- `agents` (UUID id, slug unique, name, description, privacy_profile TEXT +
  CHECK strict|default, status enabled|disabled, timestamps)
- `agent_plugins` ((agent_id, plugin_id) PK, JSONB config, enabled bool)
- `channel_bindings` ((channel_type, channel_key) PK, agent_id FK)
- `platform_settings` (single-row; `fallback_agent_id` UUID nullable FK ON
  DELETE SET NULL)
- `notify_agents_changed()` trigger function + AFTER INSERT/UPDATE/DELETE
  triggers on `agents`, `agent_plugins`, `channel_bindings` (payload =
  agent_id::text). A dedicated trigger on `platform_settings` emits
  `'platform'` payload.

The repo has **no existing migration runner**. Decide one of:
(a) hand-rolled — load + apply SQL files in order on boot in
   `middleware/src/index.ts` (after `pg` pool init, before plugin activation).
   Persist applied versions in a `schema_migrations` table.
(b) lightweight library — `node-pg-migrate` or similar. Adds a dependency.

**Recommendation**: (a). Lightweight, no new dep, fits the repo's "lean +
controlled" style. Make it idempotent via `schema_migrations` lookup.

### T014 — `configStore`

`middleware/packages/harness-orchestrator/src/registry/configStore.ts`. CRUD
+ list operations against the four tables; pure SQL-through-`pg`. Surface
shape per data-model entities. Used by the registry (T015) and by US9's REST
endpoints (later).

### T015 — `OrchestratorRegistry`

`middleware/packages/harness-orchestrator/src/registry/index.ts` (and a
nested `applyDiff.ts` for US5). The registry:

- Reads the config via `configStore`.
- For each enabled Agent: resolves the per-Agent plugin set; for each plugin,
  activates it via the kernel's plugin runtime BUT with a `PluginContext`
  whose `agentId` is the Agent's slug (not the plugin's domain). This is the
  per-Agent-scoping bit — verify how `toolPluginRuntime.activate` constructs
  the ctx today and whether `agentId` is plumbed through. ⚠ **This is the
  biggest unknown of US4**; budget time for it.
- For each Agent, calls **`buildOrchestratorForAgent({agentId, model,
  maxTokens, maxToolIterations}, deps)`** from US3 (`9662377` /
  `harness-orchestrator/src/buildOrchestrator.ts`) and stores the result.
- Publishes a `chatAgent` registry keyed by `agentId` — likely a Map
  `agentId → ChatAgentBundle`. The single-Agent service-registry name
  (`chatAgent`) becomes per-Agent: how exactly the kernel resolves "which
  chatAgent for this incoming message" is **US7**'s problem (channel routing);
  US4 just builds them and holds them.

Today the orchestrator plugin's `activate()` publishes the *single* default
chatAgent via `ctx.services.provide(CHAT_AGENT_SERVICE, built.bundle)`. For
multi-orchestrator, the registry sits **alongside or above** that — easiest
shape for US4: a new registry service published *in addition* to the legacy
`chatAgent` (the default Agent's bundle stays bound there for now;
channel-binding-based resolution is US7). Don't break the default channel
boot path while doing US4.

### T016 — Config validation

In `configStore` write paths: reject duplicate `channel_key`s (the composite
PK handles it at DB level — surface the error nicely), reject a
`multi_instance: false` plugin assigned to a second `agent_id` (the data
model documents this rule), reject unsatisfiable permissions.

### T017 — CLI `agents:apply` [P]

`middleware/scripts/agents-apply.ts` (or similar) — read a YAML config from
disk, write to the DB. For local E2E without UI. Operator-readable input.

### T018 — Runtime plugin-error isolation

In `harness-orchestrator/src/orchestrator.ts` (the `Orchestrator` class):
catch runtime errors thrown by a plugin's tool dispatch in one Agent's turn
so a throw cannot crash the process or degrade another Agent. There's
already partial isolation (tool dispatch is per-call); confirm the seam.
FR-009 / SC-007.

### T019 — Test

`middleware/test/orchestratorRegistry.test.ts`. Build the registry with a
two-Agent config; assert isolation (one Agent's plugin set is unreachable
from the other); assert independent `Orchestrator` instances; assert
SC-007 isolation behaviour.

**Boot smoke (Constitution IV)**: start the platform with both Agents, send
one request per Agent, check the log monitor shows them serving
independently. Sandbox can't run a full server boot (no API key, no DB) —
do this on the real machine; capture the smoke result in the commit message.

### Exploration recipe for US4

Before writing the registry, read:
- `middleware/src/plugins/toolPluginRuntime.ts` — how plugins activate
  per-`agentId` today, and how to construct a `PluginContext` with a
  custom `agentId`.
- `middleware/src/platform/pluginContext.ts` — the kernel-side ctx
  constructor.
- `middleware/src/index.ts` — the boot order
  (`toolPluginRuntime.activateAllInstalled()` → resolve `chatAgent` from
  `serviceRegistry` → `dynamicAgentRuntime.attachOrchestrator(...)` →
  `channelRegistry.activateAllInstalled()`). The registry must slot
  *between* plugin activation and `attachOrchestrator`.

---

## P2 / P3 outlook

After US4 lands, the priority cascade is:

- **P2**: US5 hot-reload (`applyDiff` + `LISTEN/NOTIFY` + reconcile) ∥ US6
  in-flight-session snapshot + two-mode `force-invalidate` → US7 channel
  routing (`channelResolver`, `fallbackAgentId`, FR-021 onboarding seed).
- **P3**: US8 memory scoping by `permissions.memory` → US9 operator UI
  ("Agents" tab in `web-ui`, FR-019).

`tasks.md` carries the dependency graph and parallel opportunities.

---

## Open small items

- **`docs/specs:` re-baseline note** says T004 validation moved loader-side;
  the Builder-spec linter check landed in US2 (`manifestLinter.ts`) anyway.
  Spec consistent.
- **Node-24 upgrade** — separate ticket, not on the multi-orchestrator
  critical path.
- **`CLAUDE.md`** at repo root (untracked, from `specify init`) — has been
  intentionally not committed. The two `CLAUDE.local.md` / `.claude/CLAUDE.md`
  are the active project-context files.

---

## One-liner to resume

```
cd ~/sources/odoo-bot-multi-orchestrator
git log --oneline -10
cat specs/001-multi-orchestrator-runtime/HANDOFF-2026-05-22-us4-start.md
# Read tasks.md §"Phase 6: User Story 4" (T013–T019) and start exploring
# middleware/src/plugins/toolPluginRuntime.ts + src/index.ts boot order.
```

The factory `buildOrchestratorForAgent` is the lever — US4 is "wire it to a
DB-backed registry and surface N bundles to the channel layer."
