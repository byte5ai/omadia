/**
 * Plugin lifecycle contract — the authoritative definition of what a
 * plugin is: how it is created, configured, and torn down.
 *
 * Part of the multi-orchestrator runtime (US1). This contract is the
 * single source of truth (Constitution II): orchestrators, the
 * `OrchestratorRegistry`, and the Agent Builder all import these types
 * from `@omadia/plugin-api` — none re-declares them.
 *
 * A breaking change here requires a SemVer major bump of
 * `@omadia/plugin-api` and a written migration note.
 *
 * See `specs/001-multi-orchestrator-runtime/contracts/plugin-lifecycle.md`.
 */

import type { PluginManifest } from './manifest.js';

/**
 * A teardown handle. `dispose()` MUST be idempotent and MUST NOT throw
 * for an already-disposed resource.
 */
export interface Disposable {
  dispose(): Promise<void> | void;
}

/** Structured fields merged into a single log record. */
export type LogFields = Record<string, unknown>;

/**
 * A structured logger pre-bound with `agentId` + `pluginId`. Every
 * record it emits carries that context, so lifecycle, routing, and
 * reload seams are reconstructable from logs alone (Constitution VI).
 * Callers add per-call context (e.g. `sessionId`) through `fields`.
 */
export interface ScopeLogger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

/**
 * Capability-keyed service resolver handed to a plugin through its
 * scope. The registry populates it with exactly the capabilities the
 * plugin declared in `manifest.requiredCapabilities` — nothing else.
 */
export interface ScopeServices {
  /**
   * Resolve a capability. Throws if the capability was not declared
   * in the manifest's `requiredCapabilities` — a plugin cannot reach
   * a service it did not ask for (Constitution V).
   */
  get<T>(capability: string): T;
  /** True when `capability` is resolvable from this scope. */
  has(capability: string): boolean;
}

/**
 * Per-(Agent × plugin) runtime container handed to a plugin at
 * `init()`. A plugin obtains everything external through the scope —
 * never via module-scope imports of singletons.
 */
export interface PluginScope {
  /** The Agent (orchestrator instance) this scope belongs to. */
  readonly agentId: string;
  /** The plugin this scope belongs to. */
  readonly pluginId: string;
  /** Capability-keyed service resolver. */
  readonly services: ScopeServices;
  /** Structured logger pre-bound with `agentId` + `pluginId`. */
  readonly logger: ScopeLogger;
  /**
   * Register a teardown handle. All registered handles are flushed,
   * in reverse registration order, when the plugin is disposed.
   */
  registerDisposable(d: Disposable): void;
}

/**
 * The plugin contract.
 *
 * @typeParam C - the plugin's validated configuration type.
 * @typeParam H - the plugin's runtime handle type — whatever `init`
 *   returns and `dispose` releases.
 */
export interface Plugin<C = unknown, H = unknown> {
  /** Declarative plugin metadata. */
  readonly manifest: PluginManifest;

  /**
   * Create all runtime state (clients, caches, timers, listeners)
   * here and return the runtime handle. MUST NOT touch module-scope
   * mutable state. If `init` cannot complete (bad config,
   * unsatisfiable capability) it MUST throw; the registry isolates
   * the failure to this one plugin on this one Agent and logs it.
   */
  init(scope: PluginScope, config: C): Promise<H>;

  /**
   * Release everything created in `init()`. MUST be safe to call once
   * per handle and MUST NOT throw for an already-released resource. A
   * throwing `dispose()` is caught and isolated by the registry — it
   * never blocks reload of other plugins or Agents.
   */
  dispose(handle: H): Promise<void>;

  /**
   * OPTIONAL fast path for a config-only change: mutate in place
   * instead of a full `dispose()` + `init()` cycle. When absent, the
   * registry falls back to `dispose()` + `init()`. Returns the
   * (possibly new) handle.
   */
  reconfigure?(handle: H, next: C): Promise<H>;
}
