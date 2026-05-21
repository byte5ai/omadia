# Implementation Plan: Multi-Orchestrator Runtime

**Branch**: `001-multi-orchestrator-runtime` | **Date**: 2026-05-21 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/001-multi-orchestrator-runtime/spec.md`

## Summary

Turn the single, process-global `Orchestrator` into a multi-tenant runtime. An
`OrchestratorRegistry` instantiates N named Agents from operator-managed
configuration; each Agent owns an isolated set of `PluginScope`s. Plugins gain
an explicit `init`/`dispose`/`reconfigure` lifecycle defined once in
`plugin-api`. Configuration lives in Postgres and is hot-reloaded via
`LISTEN/NOTIFY` + a `Registry.applyDiff` patch step — no process restart.
In-flight sessions are protected by a start-time config snapshot. Inbound
channel webhooks are routed to the owning Agent by a binding resolver. Memory
visibility is scoped to the union of an Agent's plugins' namespaces. The Agent
Builder is conditioned on the frozen contract so every generated plugin is
multi-orchestrator-ready, enforced by a four-check builder-ready gate.

## Technical Context

**Language/Version**: TypeScript 5.x, strict mode; Node 22.12.0 (pinned `.nvmrc`)
**Primary Dependencies**: existing `harness-*` monorepo packages, Express
(HTTP/webhooks), `pg` (Neon Postgres client, `LISTEN/NOTIFY`), Anthropic SDK,
React (dashboard `web-ui`), `harness-ui-helpers` (plugin-UI platform)
**Storage**: Neon Postgres — new config tables (`agents`, `agent_plugins`,
`channel_bindings`, `platform_settings`); existing `chatSessionStore` extended
with a config snapshot
**Testing**: vitest (middleware unit + integration), boot smoke tests
(`middleware/scripts/smoke-*.{ts,mjs}`)
**Target Platform**: Linux server on Fly.io (one or more warm machines)
**Project Type**: web-service (TypeScript monorepo middleware) + web frontend
(React dashboard)
**Performance Goals**: config change visible to new sessions ≤ 10 s (SC-002);
hot-reload causes zero downtime for unrelated Agents
**Constraints**: no Node process restart on config change; one bad plugin must
not wedge reload or other Agents; in-flight sessions immutable
**Scale/Scope**: small N of Agents (single-digit to low-double-digit); ~22
existing plugins to migrate; one new dashboard tab

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Compliance |
|---|---|
| I. Plugin Isolation & Lifecycle | **Core driver.** US1/US3 define and enforce `init`/`dispose` and the no-module-state rule; the `dispose-roundtrip` test is the proof. |
| II. Contract-First Extensibility | `plugin-api` is the single source of truth (US1); the Builder consumes it, never a local copy (US2). |
| III. Server-Side Business Logic | Routing resolution, namespace-union computation, and config validation are server-side; the Agents UI is display + input only. |
| IV. Test-Green Gate | Each user story carries an independent test; `dispose-roundtrip` and the builder-ready gate become CI gates. Per-step boot smoke tests required. |
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
├── data-model.md        # Entities, DB schema, manifest schema
├── contracts/
│   └── plugin-lifecycle.md   # Plugin / PluginScope / manifest contract
└── tasks.md             # Task breakdown by user story
```

### Source Code (repository root)

```text
middleware/packages/
├── plugin-api/                       # US1 — frozen lifecycle + manifest contract
│   ├── src/lifecycle.ts              #   Plugin, PluginScope, Disposable
│   ├── src/manifest.ts               #   extended PluginManifest type
│   └── schemas/manifest.schema.json  #   JSON Schema for the gate
├── harness-orchestrator/
│   ├── src/orchestrator.ts           # existing Orchestrator (consumes a scope)
│   ├── src/registry/                 # US4 — OrchestratorRegistry, applyDiff
│   ├── src/registry/configStore.ts   # US4 — Postgres-backed config repository
│   ├── src/registry/reloadBus.ts     # US5 — LISTEN/NOTIFY + reconcile fallback
│   ├── src/pluginScope.ts            # US3/US4 — per-(Agent×plugin) container
│   ├── src/chatSessionStore.ts       # US6 — add configSnapshot
│   └── src/routing/channelResolver.ts# US7 — channel binding → Agent
├── harness-memory/
│   └── src/                          # US8 — namespace-scoped read/write
├── harness-channel-*/, harness-integration-*/, agent-*/,
│   harness-plugin-*/                  # US3 — migrate each to init/dispose
└── <agent-builder package>/          # US2 — templates, builder-ready gate

middleware/migrations/                # US4/US7 — agents, agent_plugins, channel_bindings, platform_settings
middleware/scripts/smoke-*.{ts,mjs}   # per-story boot smoke tests

web-ui/                               # US9 — "Agents" dashboard tab
```

**Structure Decision**: Web-service + web-frontend. All runtime work lands in
the existing npm workspace `middleware/packages/*`; the new contract is a
dedicated package boundary (`plugin-api`) to make Constitution Principle II
physically enforceable. The registry and routing live inside
`harness-orchestrator` as new sub-modules rather than a new package, because
they share the orchestrator's lifecycle and have no independent consumer. The
operator UI is a tab in the existing `web-ui` dashboard using the established
plugin-UI platform (`harness-ui-helpers`).

## Phasing

Implementation follows the user-story priority cascade in `tasks.md`:

- **P1 (MVP)**: US1 contract → US2 Builder conditioning → US3 plugin migration →
  US4 registry + config store. End state: multiple orchestrators run from
  config (restart-based apply).
- **P2**: US5 hot-reload → US6 session snapshot pinning → US7 channel routing.
  End state: live, zero-downtime reconfiguration and correct per-channel
  routing.
- **P3**: US8 memory namespace scoping → US9 operator "Agents" UI. End state:
  full privacy-by-capability and operator self-service.

US1 and US2 are time-critical: the Agent Builder runs in a parallel worktree
and must be re-pointed at the frozen contract before it emits further plugins.

## Complexity Tracking

> No constitution violations. No entries.
