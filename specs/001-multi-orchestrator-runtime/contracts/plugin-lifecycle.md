# Contract: Plugin Lifecycle & Manifest

Phase 1 output. The authoritative interface for plugins in the
multi-orchestrator runtime. This contract lives in the `plugin-api` package and
is the **single source of truth** (Constitution II) — plugins, the
`OrchestratorRegistry`, and the Agent Builder all import from here; none
re-declares it.

A breaking change to this contract requires a SemVer major bump of `plugin-api`
and a migration note.

## 1. Lifecycle Interface

```ts
// plugin-api/src/lifecycle.ts

/** A teardown handle. dispose() MUST be idempotent and MUST NOT throw for
 *  an already-disposed resource. */
export interface Disposable {
  dispose(): Promise<void> | void;
}

/** Per-(Agent × plugin) runtime container handed to a plugin at init().
 *  A plugin obtains everything external through the scope — never via
 *  module-scope imports of singletons. */
export interface PluginScope {
  readonly agentId: string;
  readonly pluginId: string;

  /** Capability-keyed service resolver. Throws if the capability was not
   *  declared in the manifest's requiredCapabilities. */
  readonly services: {
    get<T>(capability: string): T;
    has(capability: string): boolean;
  };

  /** Structured logger pre-bound with agentId + pluginId. */
  readonly logger: ScopeLogger;

  /** Register a teardown handle; all registered handles are flushed,
   *  in reverse order, when the plugin is disposed. */
  registerDisposable(d: Disposable): void;
}

/** The plugin contract. C = plugin config type, H = plugin runtime handle. */
export interface Plugin<C = unknown, H = unknown> {
  readonly manifest: PluginManifest;

  /** Create all runtime state (clients, caches, timers, listeners) here.
   *  MUST NOT touch module-scope mutable state. Returns the runtime handle. */
  init(scope: PluginScope, config: C): Promise<H>;

  /** Release everything created in init(). MUST be safe to call once per
   *  handle. Errors are isolated by the registry — a throwing dispose() MUST
   *  NOT prevent other plugins/Agents from reloading. */
  dispose(handle: H): Promise<void>;

  /** OPTIONAL fast path for a config-only change: mutate in place instead of
   *  a full dispose()+init() cycle. If absent, the registry falls back to
   *  dispose()+init(). Returns the (possibly new) handle. */
  reconfigure?(handle: H, next: C): Promise<H>;
}
```

### Lifecycle rules

1. **No module-scope mutable state.** Every client, cache, timer, interval,
   event listener, subscription, or connection is created inside `init()` and
   torn down inside `dispose()`. Enforced by the `no-module-state` ESLint rule.
2. **`init` is total.** If `init` cannot complete (bad config, unsatisfiable
   capability), it throws; the registry isolates the failure to that one
   plugin on that one Agent and logs it.
3. **`dispose` is idempotent and total.** It releases every handle registered
   via `registerDisposable`, in reverse order, and never throws for an
   already-released resource.
4. **Multi-instance by default.** A plugin must tolerate being `init()`-ed
   more than once concurrently in the same process against different scopes,
   unless the manifest declares `multiInstance: false`.
5. **Scope-only access.** External services are obtained via
   `scope.services.get(...)`. Importing a singleton at module scope is a
   contract violation.

## 2. Manifest Interface

```ts
// plugin-api/src/manifest.ts

export interface PluginManifest {
  // --- existing fields (unchanged) ---
  id: string;
  name: string;
  version: string;            // SemVer

  // --- NEW: required for the multi-orchestrator runtime ---

  /** May this plugin run as more than one instance in a single process?
   *  Default true. */
  multiInstance: boolean;

  /** Required (non-empty) when multiInstance is false — why it cannot. */
  multiInstanceJustification?: string;

  /** Memory partitions this plugin contributes. [] ⇒ uses only "core". */
  memoryNamespaces: string[];

  /** Capabilities the plugin needs from its scope, e.g. "llm:chat". */
  requiredCapabilities: string[];

  /** Data-handling class. Builder-generated plugins default to "strict". */
  privacyClass: 'strict' | 'default';
}
```

## 3. Manifest JSON Schema

Lives at `plugin-api/schemas/manifest.schema.json`; the builder-ready gate
validates every manifest against it.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "PluginManifest",
  "type": "object",
  "required": ["id", "name", "version", "multiInstance",
               "memoryNamespaces", "requiredCapabilities", "privacyClass"],
  "properties": {
    "id":      { "type": "string", "minLength": 1 },
    "name":    { "type": "string", "minLength": 1 },
    "version": { "type": "string",
                 "pattern": "^\\d+\\.\\d+\\.\\d+([-+].+)?$" },
    "multiInstance": { "type": "boolean" },
    "multiInstanceJustification": { "type": "string", "minLength": 1 },
    "memoryNamespaces": {
      "type": "array", "items": { "type": "string", "minLength": 1 }
    },
    "requiredCapabilities": {
      "type": "array", "items": { "type": "string", "minLength": 1 }
    },
    "privacyClass": { "enum": ["strict", "default"] }
  },
  "if":   { "properties": { "multiInstance": { "const": false } } },
  "then": { "required": ["multiInstanceJustification"] }
}
```

## 4. Builder-Ready Gate

A plugin is publishable only when all four checks pass (FR-005). The gate runs
in CI and in the Agent Builder; a failing check disables the publish action and
names the failure.

| # | Check | Tool / Method |
|---|---|---|
| 1 | Lifecycle contract implemented | `tsc` against the `Plugin` interface from `plugin-api` |
| 2 | No module-scope mutable state | custom ESLint rule `no-module-state` |
| 3 | Dispose-roundtrip clean | `vitest` runs the mandatory `dispose-roundtrip` test |
| 4 | Manifest valid | JSON Schema validation against `manifest.schema.json` |

### Mandatory `dispose-roundtrip` test (generated for every plugin)

```ts
it('survives init → dispose → init → dispose without leaking handles', async () => {
  const before = (process as any)._getActiveHandles().length;
  for (let i = 0; i < 3; i++) {
    const handle = await plugin.init(testScope(), testConfig());
    await plugin.dispose(handle);
  }
  expect((process as any)._getActiveHandles().length).toBe(before);
});
```

## 5. Registry Consumption Contract

The `OrchestratorRegistry` (in `harness-orchestrator`) is the only caller of
`init`/`dispose`/`reconfigure`. It guarantees:

- One `PluginScope` is built per (Agent × plugin); `services` is populated only
  with the plugin's declared `requiredCapabilities`.
- `applyDiff` calls `reconfigure` for a config-only change when the plugin
  provides it, otherwise `dispose` + `init`.
- A throwing `init` or `dispose` is caught, logged with `agentId`+`pluginId`,
  and isolated — it never blocks reload of other plugins or Agents.
- A plugin with `multiInstance: false` is rejected if assigned to a second
  Agent.
