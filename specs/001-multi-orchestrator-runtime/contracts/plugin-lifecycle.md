# Contract: Plugin Lifecycle & Manifest Extension

Phase 1 output. The plugin contract the multi-orchestrator registry builds
against. **The lifecycle already exists** — this document references it rather
than redefining it — and the multi-orchestrator runtime adds two manifest
fields. See the 2026-05-21 re-baseline note in `spec.md`.

## 1. Lifecycle — the existing `activate` / `close` contract

Every plugin in the platform already follows one lifecycle. It is **not changed
by this feature**:

```ts
// Each plugin module exports:
export async function activate(ctx: PluginContext): Promise<Handle>;
// where the returned Handle has:
//   close(): Promise<void>;
```

- **`activate(ctx)`** — the kernel calls this once per (Agent × plugin),
  passing a `PluginContext` scoped to that Agent. The plugin creates its
  runtime state (clients, caches, timers, service registrations) and returns a
  handle.
- **`handle.close()`** — releases everything `activate()` created. The registry
  calls it on plugin removal, Agent removal, or reload. There is no shared
  `Handle` type; a `close()` method is the convention.
- **`PluginContext`** — defined in `@omadia/plugin-api`
  (`src/pluginContext.ts`); it is the single source of truth (Constitution II)
  and is reused unchanged. It already carries `agentId`, `domain`, a service
  registry (`services.provide`/`get`), `config`, `secrets`, `log()`, `jobs`,
  `tools`, `routes`, and capability-gated optional accessors (`memory?`,
  `llm?`, `http?`, `knowledgeGraph?`, `subAgent?`) that are present only when
  the plugin's manifest declares the matching `permissions.*` — i.e. the
  privacy-by-capability boundary (Constitution V) is already structural.

What the registry guarantees when it drives this lifecycle:

- One `PluginContext` per (Agent × plugin); a plugin reaches only what its
  manifest permissions grant.
- A throwing `activate()` or `close()` is caught, logged with
  `agentId` + `pluginId`, and isolated — it never blocks reload of other
  plugins or Agents.
- There is no in-place `reconfigure`. A plugin-config change is applied as
  `close()` then `activate()`.

## 2. Manifest Extension

This feature adds two fields to the existing plugin `manifest.yaml`
(`schema_version: "1"`). All other manifest fields — `identity`, `compat`,
`permissions`, `jobs`, `capabilities`, … — are unchanged.

Field names are snake_case, matching the existing top-level manifest keys
(`schema_version`, `depends_on`, `is_reference_only`).

| Field | Type | Required | Meaning |
|---|---|---|---|
| `multi_instance` | `boolean` | optional, defaults `true` | May the plugin be activated for more than one Agent in one process? |
| `multi_instance_justification` | `string` | required iff `multi_instance: false` | Non-empty reason the plugin cannot be multi-instance. |
| `privacy_class` | `'strict' \| 'default'` | optional, defaults `default` | Plugin's data-handling class. Recorded, not enforced this feature (research C3). |

The fields surface in these existing places:

- **`manifest.yaml`** — plugins (and the Builder boilerplate) declare them.
- **`adaptManifestV1()` in `manifestLoader.ts`** — maps them onto the loaded
  `Plugin` object (`middleware/src/api/admin-v1.ts`), applying the defaults
  and warning on an invalid value (see §3).
- **`manifestLinter.ts`** (Builder spec) — gains the same checks in US2, once
  the Builder's `AgentSpecSkeleton` carries the fields.

`memoryNamespaces` and `requiredCapabilities` are **not** added — memory
scoping derives from the manifest's existing `permissions.memory`, and
capability needs from the existing `permissions.*` blocks.

## 3. Manifest Validation

US1 validates at load time, in `adaptManifestV1()` (`manifestLoader.ts`),
following the loader's graceful-degradation contract:

- `multi_instance` defaults to `true`; only an explicit `false` is honoured.
- `multi_instance: false` with no non-empty `multi_instance_justification`
  loads but logs a warning naming the plugin.
- `privacy_class` defaults to `default`; an unknown value loads, warns, and
  falls back to `default`.

The Builder-side hard gate — `manifestLinter` rejecting an invalid spec —
lands in US2, once the Builder's `AgentSpecSkeleton` carries the fields.

## 4. Registry Consumption

The `OrchestratorRegistry` (in `harness-orchestrator`) drives the lifecycle:

- It activates each Agent's plugin set, building one `PluginContext` per
  (Agent × plugin), and tracks the returned `close()` handles for reload and
  shutdown.
- `applyDiff` adds a plugin by `activate()`, removes one by `close()`, and
  applies a config change as `close()` + `activate()`.
- A plugin whose manifest declares `multiInstance: false` is rejected if it is
  assigned to a second Agent — checked at `applyDiff`.
