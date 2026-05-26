import {
  buildOrchestratorForAgent,
  type AgentRuntimeConfig,
  type BuiltOrchestrator,
  type OrchestratorDeps,
} from '../buildOrchestrator.js';

import {
  ConfigValidationError,
  type AgentPluginRow,
  type AgentRow,
  type ChannelBindingRow,
  type ConfigSnapshot,
  type ConfigStore,
  type PlatformSettingsRow,
} from './configStore.js';

/**
 * OrchestratorRegistry (US4 / T015).
 *
 * Reads the multi-orchestrator config from the DB and builds one
 * `BuiltOrchestrator` per enabled Agent, in addition to the legacy default
 * `chatAgent` bundle that the orchestrator plugin publishes for backward-
 * compatible single-Agent boot.
 *
 * For US4 (MVP) the registry **does not** activate plugins per-Agent — every
 * installed plugin still activates once globally during
 * `toolPluginRuntime.activateAllInstalled()`, so the runtime tool dispatch
 * is shared across all Agents. Each Agent does, however, get an independent
 * `Orchestrator` + `ChatSessionStore` + `SessionLogger` (the entire
 * `BuiltOrchestrator` is produced by `buildOrchestratorForAgent`), so per-
 * Agent state (sessions, turn budgets, accumulator state) is isolated.
 *
 * Per-Agent plugin activation with `PluginContext.agentId = agent.slug` is
 * the cleaner architecture but requires a deeper refactor of the
 * tool-plugin runtime — deferred to US5 / US6 when hot-reload makes the
 * per-(Agent × plugin) lifecycle a first-class concept.
 *
 * Routing (channel_bindings → Agent) lives on the registry but the static
 * webhook handlers are not yet wired through it — that is US7. US4 only
 * needs the registry to *exist* and expose the lookup surface.
 */

export interface PluginCapabilityLookup {
  /**
   * Returns `true` when the plugin is safe to run as more than one Agent
   * instance, `false` when the plugin manifest declares
   * `multi_instance: false`, `undefined` when the plugin is not in the
   * catalog (treated as "unknown — assume safe + warn" by the registry, to
   * match the loader's graceful-degradation contract).
   */
  isMultiInstance(pluginId: string): boolean | undefined;
  /**
   * Returns `true` when the plugin is installed and its declared
   * permissions are satisfiable by the platform (i.e. every required
   * capability has a provider). `false` rejects the snapshot. `undefined`
   * means the registry has no opinion — used when an integration plugin
   * for the running deployment isn't installed yet.
   */
  isInstalled?(pluginId: string): boolean | undefined;
}

export interface OrchestratorRegistryOptions {
  /**
   * Runtime config applied to every Agent built by the registry (model,
   * token budget, iteration cap). Per-Agent overrides are a future
   * enhancement — for US4 every Agent shares the same runtime config so the
   * registry behaves identically to the legacy default boot.
   */
  readonly defaultRuntimeConfig: Omit<AgentRuntimeConfig, 'agentId'>;
  /**
   * Optional manifest capability lookup. When provided, the registry rejects
   * snapshots that assign a `multi_instance: false` plugin to more than one
   * Agent (T016).
   */
  readonly pluginLookup?: PluginCapabilityLookup;
  /**
   * Structured log sink. Defaults to a noop so tests stay quiet; production
   * boot wires `console.log` here.
   */
  readonly log?: (msg: string, fields?: Record<string, unknown>) => void;
}

export interface ActiveAgent {
  readonly agent: AgentRow;
  readonly plugins: readonly AgentPluginRow[];
  readonly bindings: readonly ChannelBindingRow[];
  readonly built: BuiltOrchestrator;
}

export class OrchestratorRegistry {
  private readonly active = new Map<string, ActiveAgent>();
  private platformSettings: PlatformSettingsRow = {
    fallbackAgentId: null,
    updatedAt: new Date(0),
  };
  private snapshot: ConfigSnapshot | undefined;

  constructor(
    private readonly store: ConfigStore,
    private readonly deps: OrchestratorDeps,
    private readonly options: OrchestratorRegistryOptions,
  ) {}

  /**
   * Initial load — call once after the plugin runtime has finished activating
   * (so `deps` is fully populated) and migrations have run.
   */
  async start(): Promise<void> {
    const snap = await this.store.loadSnapshot();
    this.applySnapshot(snap);
  }

  /**
   * Replace the in-memory state with a freshly-loaded snapshot. Used by
   * `start()` and (in US5) by the LISTEN/NOTIFY reload bus. The current
   * implementation rebuilds every Agent from scratch — diffing is US5/T020.
   */
  applySnapshot(snap: ConfigSnapshot): void {
    validateSnapshot(snap, this.options.pluginLookup);

    const next = new Map<string, ActiveAgent>();
    const pluginsByAgent = groupBy(snap.agentPlugins, (p) => p.agentId);
    const bindingsByAgent = groupBy(snap.channelBindings, (b) => b.agentId);

    for (const agent of snap.agents) {
      if (agent.status !== 'enabled') continue;
      const plugins = pluginsByAgent.get(agent.id) ?? [];
      const bindings = bindingsByAgent.get(agent.id) ?? [];
      // FR-009 / SC-007 (T018): build each Agent in isolation. A throw here
      // takes down only the failing Agent; the rest of the registry still
      // comes up. The orchestrator plugin's per-turn `Promise.allSettled`
      // dispatch handles tool throws separately — see orchestrator.ts.
      let built;
      try {
        built = buildOrchestratorForAgent(
          {
            agentId: agent.slug,
            model: this.options.defaultRuntimeConfig.model,
            maxTokens: this.options.defaultRuntimeConfig.maxTokens,
            maxToolIterations:
              this.options.defaultRuntimeConfig.maxToolIterations,
          },
          this.deps,
        );
      } catch (err) {
        this.log(`registry: agent build FAILED — skipping`, {
          slug: agent.slug,
          agentId: agent.id,
          error: (err as Error).message,
        });
        continue;
      }
      next.set(agent.slug, { agent, plugins, bindings, built });
      this.log(`registry: built agent`, {
        slug: agent.slug,
        agentId: agent.id,
        plugins: plugins.filter((p) => p.enabled).map((p) => p.pluginId),
      });
    }

    this.active.clear();
    for (const [slug, entry] of next) this.active.set(slug, entry);
    this.platformSettings = snap.platformSettings;
    this.snapshot = snap;
  }

  /** Number of enabled Agents currently held by the registry. */
  size(): number {
    return this.active.size;
  }

  /** Iterator over every active Agent. */
  list(): readonly ActiveAgent[] {
    return Array.from(this.active.values());
  }

  /** Look up an Agent by its slug. */
  get(slug: string): ActiveAgent | undefined {
    return this.active.get(slug);
  }

  /**
   * Resolve a webhook → Agent via the channel_bindings table. Returns
   * `undefined` when no binding matches AND no fallback Agent is configured;
   * returns the fallback Agent when one is set; the caller decides how to
   * surface the unbound case (hard-reject vs. fall through). US7 wires the
   * static channel adapters through this method.
   */
  resolveByChannel(
    channelType: string,
    channelKey: string,
  ): ActiveAgent | undefined {
    for (const entry of this.active.values()) {
      for (const binding of entry.bindings) {
        if (
          binding.channelType === channelType &&
          binding.channelKey === channelKey
        ) {
          return entry;
        }
      }
    }
    const fallbackId = this.platformSettings.fallbackAgentId;
    if (!fallbackId) return undefined;
    for (const entry of this.active.values()) {
      if (entry.agent.id === fallbackId) return entry;
    }
    return undefined;
  }

  /** The currently-held snapshot. Useful for diffing in US5. */
  currentSnapshot(): ConfigSnapshot | undefined {
    return this.snapshot;
  }

  private log(msg: string, fields?: Record<string, unknown>): void {
    this.options.log?.(msg, fields);
  }
}

/**
 * Validation rules enforced before the registry materialises a snapshot
 * (T016). The DB enforces uniqueness; this catches the rules the DB can't
 * see (manifest-driven `multi_instance: false` on a second Agent).
 */
export function validateSnapshot(
  snap: ConfigSnapshot,
  pluginLookup?: PluginCapabilityLookup,
): void {
  const seenSlugs = new Set<string>();
  for (const agent of snap.agents) {
    if (seenSlugs.has(agent.slug)) {
      throw new ConfigValidationError(
        `duplicate agent slug "${agent.slug}" in snapshot`,
      );
    }
    seenSlugs.add(agent.slug);
  }

  const seenBindings = new Set<string>();
  for (const binding of snap.channelBindings) {
    const key = `${binding.channelType} ${binding.channelKey}`;
    if (seenBindings.has(key)) {
      throw new ConfigValidationError(
        `duplicate channel binding (${binding.channelType}, ${binding.channelKey})`,
      );
    }
    seenBindings.add(key);
  }

  if (pluginLookup) {
    const agentsByPlugin = new Map<string, string[]>();
    for (const row of snap.agentPlugins) {
      if (!row.enabled) continue;
      const list = agentsByPlugin.get(row.pluginId);
      if (list) list.push(row.agentId);
      else agentsByPlugin.set(row.pluginId, [row.agentId]);
    }
    for (const [pluginId, agentIds] of agentsByPlugin) {
      if (pluginLookup.isInstalled) {
        const installed = pluginLookup.isInstalled(pluginId);
        if (installed === false) {
          throw new ConfigValidationError(
            `plugin "${pluginId}" is not installed or its permissions are not satisfiable on this platform`,
          );
        }
      }
      if (agentIds.length < 2) continue;
      const ok = pluginLookup.isMultiInstance(pluginId);
      if (ok === false) {
        throw new ConfigValidationError(
          `plugin "${pluginId}" declares multi_instance: false and cannot be enabled on more than one agent (assigned to ${String(agentIds.length)})`,
        );
      }
    }
  }
}

function groupBy<T, K>(
  items: readonly T[],
  keyFn: (item: T) => K,
): Map<K, T[]> {
  const out = new Map<K, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    const list = out.get(key);
    if (list) list.push(item);
    else out.set(key, [item]);
  }
  return out;
}
