# Implementation Plan: Multi-Orchestrator Runtime

**Branch**: `001-multi-orchestrator-runtime` | **Date**: 2026-05-21 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/001-multi-orchestrator-runtime/spec.md`

## Summary

Turn the single, process-global `Orchestrator` into a multi-tenant runtime. An
`OrchestratorRegistry` instantiates N named Agents from operator-managed
configuration; each Agent owns its own plugin activations, each plugin activated
against a per-Agent `PluginContext`. The platform's existing plugin lifecycle
(`activate(ctx)` / `handle.close()`) is reused as-is — no new contract. The
plugin manifest is extended with `multiInstance` (and `privacyClass`), and
`Orchestrator` construction is refactored into a function parameterized per
Agent. Configuration lives in Postgres and is hot-reloaded via `LISTEN/NOTIFY`
+ a `Registry.applyDiff` patch step — no process restart. In-flight sessions
are protected by a start-time config snapshot. Inbound channel webhooks are
routed to the owning Agent by a binding resolver. Memory visibility is scoped to
the union of an Agent's plugins' existing `permissions.memory` declarations. The
Agent Builder emits the new manifest fields so generated plugins are
registry-ready.

## Technical Context

**Language/Version**: TypeScript 6.x, strict mode; Node 22.22.3 (pinned `.nvmrc`)
**Primary Dependencies**: existing `harness-*` monorepo packages, Express
(HTTP/webhooks), `pg` (Neon Postgres client, `LISTEN/NOTIFY`), Anthropic SDK,
React (dashboard `web-ui`), `harness-ui-helpers` (plugin-UI platform)
**Storage**: Neon Postgres — new config tables (`agents`, `agent_plugins`,
`channel_bindings`, `platform_settings`); existing `chatSessionStore` extended
with a config snapshot
**Testing**: Node's native test runner (`node --import tsx --test`, repo
convention), boot smoke tests (`middleware/scripts/smoke-*.{ts,mjs}`)
**Target Platform**: Linux server on Fly.io (one or more warm machines)
**Project Type**: web-service (TypeScript monorepo middleware) + web frontend
(React dashboard)
**Performance Goals**: config change visible to new sessions ≤ 10 s (SC-002);
hot-reload causes zero downtime for unrelated Agents
**Constraints**: no Node process restart on config change; one bad plugin must
not wedge reload or other Agents; in-flight sessions immutable
**Scale/Scope**: small N of Agents (single-digit to low-double-digit); the
existing ~13 plugins are reused unchanged (already `activate`/`close`-
conformant); one new dashboard tab

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Compliance |
|---|---|
| I. Plugin Isolation & Lifecycle | Satisfied by the existing lifecycle: every plugin already implements `activate`/`close` with per-plugin `PluginContext` scoping. This feature reuses it and adds `multiInstance` so the registry knows a plugin's multi-instance safety. |
| II. Contract-First Extensibility | `plugin-api` already holds the `PluginContext` contract as the single source of truth; this feature extends the manifest, it does not add a parallel contract. |
| III. Server-Side Business Logic | Routing resolution, memory-scope-union computation, and config validation are server-side; the Agents UI is display + input only. |
| IV. Test-Green Gate | Each user story carries an independent test; `manifestLinter` enforces the new fields in CI. Per-step boot smoke tests required. |
| V. Privacy by Capability | Memory visibility (US8) is a set operation over enabled plugins; an Agent structurally cannot reach an un-enabled plugin (US4/FR-008). |
| VI. Observability & Diagnostics | FR-020 requires structured logs on lifecycle, routing, and reload seams. |

No violations. Complexity Tracking table is empty.

## Project Structure

### Documentation (this feature)

```text
specs/001-multi-orchestrator-runtime/
├── spec.md              # Feature specification (the WHAT)
├── plan.md              # This file (the HOW)
├── research.md          # Resolved design decisions & rejected alternatives
├── data-model.md        # Entities, DB schema, manifest extension
├── contracts/
│   └── plugin-lifecycle.md   # existing activate/close lifecycle + manifest extension
└── tasks.md             # Task breakdown by user story
```

### Source Code (repository root)

```text
middleware/src/
├── api/admin-v1.ts                   # US1 — `Plugin` type: add multiInstance, privacyClass
├── plugins/manifestLoader.ts         # US1 — adaptManifestV1: map the new fields
├── plugins/builder/manifestLinter.ts # US1/US2 — validate the new fields
└── plugins/builder/                  # US2 — boilerplate + manifest step emit the fields

middleware/assets/boilerplate/*/manifest.yaml  # US2 — declare the new fields

middleware/packages/harness-orchestrator/
├── src/plugin.ts                     # US3 — activate(): build Orchestrator per Agent
├── src/orchestrator.ts               # US3 — construction parameterized by Agent config
├── src/registry/                     # US4 — OrchestratorRegistry, applyDiff
├── src/registry/configStore.ts       # US4 — Postgres-backed config repository
├── src/registry/reloadBus.ts         # US5 — LISTEN/NOTIFY + reconcile fallback
├── src/chatSessionStore.ts           # US6 — add configSnapshot
└── src/routing/channelResolver.ts    # US7 — channel binding → Agent

middleware/packages/harness-memory/src/        # US8 — permissions.memory-scoped read/write
middleware/migrations/                # US4/US7 — agents, agent_plugins, channel_bindings, platform_settings
middleware/scripts/smoke-*.{ts,mjs}   # per-story boot smoke tests

web-ui/                               # US9 — "Agents" dashboard tab
```

**Structure Decision**: Web-service + web-frontend. The manifest extension (US1)
touches the existing manifest path — the `Plugin` type, `manifestLoader`,
`manifestLinter` — under `middleware/src/`. The registry and routing (US4/US7)
live inside `harness-orchestrator` as new sub-modules rather than a new package,
because they share the orchestrator's lifecycle and have no independent consumer
(Constitution: no organisational-only libraries). No new shared-contract package
is created — `plugin-api` already exists. The operator UI is a tab in the
existing `web-ui` dashboard using the established plugin-UI platform
(`harness-ui-helpers`).

## Phasing

Implementation follows the user-story priority cascade in `tasks.md`:

- **P1 (MVP)**: US1 manifest extension → US2 Builder emits the new fields →
  US3 per-Agent `Orchestrator` construction → US4 registry + config store.
  End state: multiple orchestrators run from config (restart-based apply).
- **P2**: US5 hot-reload → US6 session snapshot pinning → US7 channel routing.
  End state: live, zero-downtime reconfiguration and correct per-channel
  routing.
- **P3**: US8 memory scoping by `permissions.memory` → US9 operator "Agents"
  UI. End state: full privacy-by-capability and operator self-service.

US3 is the structural unlock — until `Orchestrator` construction is
parameterized per Agent, US4 cannot build N instances. US1/US2 are small and
can land in parallel with US3.

## Complexity Tracking

> No constitution violations. No entries.
