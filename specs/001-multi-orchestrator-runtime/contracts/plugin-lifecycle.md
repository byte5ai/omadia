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

| Field | Type | Required | Meaning |
|---|---|---|---|
| `multiInstance` | `boolean` | optional, defaults `true` | May the plugin be activated for more than one Agent in one process? |
| `multiInstanceJustification` | `string` | required iff `multiInstance: false` | Non-empty reason the plugin cannot be multi-instance. |
| `privacyClass` | `'strict' \| 'default'` | optional, defaults `default` | Plugin's data-handling class. Recorded, not enforced this feature (research C3). |

The fields surface in three existing places:

- **`manifest.yaml`** — plugins (and the Builder boilerplate) declare them.
- **`adaptManifestV1()` in `manifestLoader.ts`** — maps them onto the loaded
  `Plugin` object (`middleware/src/api/admin-v1.ts`).
- **`manifestLinter.ts`** — validates them (see §3).

`memoryNamespaces` and `requiredCapabilities` are **not** added — memory
scoping derives from the manifest's existing `permissions.memory`, and
capability needs from the existing `permissions.*` blocks.

## 3. Manifest Validation

`manifestLinter` (`middleware/src/plugins/builder/manifestLinter.ts` —
hand-rolled checks, no JSON Schema) gains rules for the new fields:

- `multiInstance`, when present, must be a boolean.
- `multiInstance: false` requires a non-empty `multiInstanceJustification`;
  otherwise the lint fails, naming the field.
- `privacyClass`, when present, must be `strict` or `default`.

The linter runs in CI and in the Agent Builder; a failing check blocks the
build / publish and names the failure.

## 4. Registry Consumption

The `OrchestratorRegistry` (in `harness-orchestrator`) drives the lifecycle:

- It activates each Agent's plugin set, building one `PluginContext` per
  (Agent × plugin), and tracks the returned `close()` handles for reload and
  shutdown.
- `applyDiff` adds a plugin by `activate()`, removes one by `close()`, and
  applies a config change as `close()` + `activate()`.
- A plugin whose manifest declares `multiInstance: false` is rejected if it is
  assigned to a second Agent — checked at `applyDiff`.
