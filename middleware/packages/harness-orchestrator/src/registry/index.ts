import type {
  AgentRuntimeConfig,
  BuiltOrchestrator,
  OrchestratorDeps,
} from '../buildOrchestrator.js';

import type { ChatSessionStore, SessionConfigSnapshot } from '../chatSessionStore.js';

import {
  buildForAgent,
  diffSnapshots,
  type DiffAction,
  type DiffPlan,
} from './applyDiff.js';
import {
  ConfigValidationError,
  type AgentPluginRow,
  type AgentRow,
  type ChannelBindingRow,
  type ConfigSnapshot,
  type ConfigStore,
  type PlatformSettingsRow,
} from './configStore.js';
import { orchestratorMemoryScope } from './scopedMemoryStore.js';

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
  /**
   * Returns the plugin's declared memory scope — the union of
   * `permissions.memory.reads` and `permissions.memory.writes` from the
   * manifest. Used by the registry (T033) to compute an Agent's effective
   * memory scope as the union of its enabled plugins' scopes plus `core`.
   *
   * `undefined` is treated as "unknown — assume no scope" so a missing
   * lookup degrades safely to "Agent has only `core` access" rather than
   * blowing the boot path open.
   */
  getMemoryScope?(pluginId: string): readonly string[] | undefined;
  /**
   * Phase B (B1) — returns the plugin IDs currently installed on the
   * platform. Used by `ensureFallbackAgent` to hydrate a fresh fallback
   * Agent with every plugin so day-1 chat is useful out-of-the-box, and
   * by the operator dashboard's "Reset fallback to all plugins" action
   * (B3d) to re-hydrate after pruning.
   *
   * Returns `undefined` when the platform has no opinion (e.g. tests with
   * no kernel-published catalog) — callers degrade to "do not attach any
   * plugins" rather than failing the seed.
   */
  listInstalled?(): readonly string[] | undefined;
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
  /**
   * Phase B fix — fired immediately after the registry builds a fresh
   * `BuiltOrchestrator` (initial `start()`, `applySnapshot`, `add` / `rebuild`
   * diff actions). The kernel uses this to push its kernel-owned
   * `DomainTool[]` set into the new Orchestrator so per-Agent chats see
   * the same tool surface as the legacy `chatAgent@1` bundle. Without it
   * each per-Agent orchestrator starts with `domainTools: []` and chat
   * against the fallback Agent can not reach `query_odoo_*`, `query_*`,
   * etc.
   *
   * Errors thrown here are caught + logged inside the registry — they
   * never abort the diff action, so a misbehaving callback can not lock
   * the registry into a half-applied state.
   */
  readonly onAgentBuilt?: (
    slug: string,
    built: BuiltOrchestrator,
    reason: 'initial' | 'add' | 'rebuild',
  ) => void;
}

export interface ActiveAgent {
  readonly agent: AgentRow;
  readonly plugins: readonly AgentPluginRow[];
  readonly bindings: readonly ChannelBindingRow[];
  readonly built: BuiltOrchestrator;
  /**
   * Strict per-orchestrator memory scope: `['core', 'orchestrator:<slug>:*']`
   * (see {@link computeMemoryScope}). The Agent may touch only its own
   * orchestrator tree plus the shared `core` namespace — never another
   * Agent's, and never a shared per-plugin namespace. Enforced at runtime by
   * the `ScopedMemoryStore` that `buildOrchestratorForAgent` wraps around the
   * shared `MemoryStore`.
   */
  readonly memoryScope: readonly string[];
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
    private options: OrchestratorRegistryOptions,
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
   * Replace the in-memory state with a freshly-loaded snapshot. Boot path —
   * computes a diff against the empty "no Agents" state so every Agent is an
   * `add` action; reuses `applyDiffActions` so the build + isolation seam is
   * identical to the hot-reload path.
   */
  applySnapshot(snap: ConfigSnapshot): void {
    const safe = this.quarantineUnsatisfiablePlugins(snap);
    validateSnapshot(safe, this.options.pluginLookup);
    const plan = diffSnapshots(this.snapshot, safe);
    this.applyDiffActions(plan, safe);
  }

  /**
   * Hot-reload entry point (US5 / T020). Loads a fresh snapshot, diffs it
   * against the registry's current view, and applies only the actions
   * needed to move state forward. Unchanged Agents are left alone — their
   * `Orchestrator` instances keep serving in-flight turns (SC-001, SC-002).
   *
   * Idempotent: a `reload()` against an unchanged DB does zero rebuilds.
   *
   * Per-action isolation (T022): a throwing build / close is caught + logged
   * and the diff continues with the next action.
   */
  async reload(): Promise<DiffPlan> {
    const snap = await this.store.loadSnapshot();
    const safe = this.quarantineUnsatisfiablePlugins(snap);
    validateSnapshot(safe, this.options.pluginLookup);
    const plan = diffSnapshots(this.snapshot, safe);
    if (plan.actions.length === 0 && !plan.platformChanged) {
      this.snapshot = safe;
      return plan;
    }
    this.applyDiffActions(plan, safe);
    return plan;
  }

  /**
   * Graceful degradation for plugins that disappeared from the platform
   * (uninstalled / unbundled between boots). Without this, a single Agent
   * with a still-enabled binding to a now-uninstalled plugin makes
   * `validateSnapshot` throw and aborts the ENTIRE registry boot — taking
   * every other Agent (including the fallback) and the operator dashboards
   * (`multi_orchestrator_unavailable` 503) down with it.
   *
   * Instead we demote only the offending binding to `enabled: false` and log
   * it loudly; the rest of the snapshot validates and publishes, and the
   * Agent keeps all of its still-installed plugins. This mirrors the
   * per-Agent build isolation (T022) one layer earlier — at the validation
   * gate that runs before the diff.
   *
   * Only a definite `isInstalled === false` is quarantined. `undefined`
   * ("the platform has no opinion") and a missing `pluginLookup` are left
   * untouched, so test / legacy boots without a catalog behave exactly as
   * before. `validateSnapshot` itself stays strict — direct callers that
   * want to reject an impossible config still get the throw.
   */
  private quarantineUnsatisfiablePlugins(
    snap: ConfigSnapshot,
  ): ConfigSnapshot {
    const lookup = this.options.pluginLookup;
    const isInstalled = lookup?.isInstalled?.bind(lookup);
    if (!isInstalled) return snap;

    let demoted = 0;
    const agentPlugins = snap.agentPlugins.map((row) => {
      if (!row.enabled) return row;
      if (isInstalled(row.pluginId) !== false) return row;
      demoted += 1;
      this.log(`registry: plugin not installed — disabling binding`, {
        agentId: row.agentId,
        pluginId: row.pluginId,
      });
      return { ...row, enabled: false };
    });

    if (demoted === 0) return snap;
    this.log(`registry: quarantined unsatisfiable plugin binding(s)`, {
      count: demoted,
    });
    return { ...snap, agentPlugins };
  }

  /**
   * Execute a `DiffPlan` against the live registry. Internal — both
   * `applySnapshot` and `reload` route through it so the build/close seams
   * + structured logging live in one place.
   */
  private applyDiffActions(plan: DiffPlan, snap: ConfigSnapshot): void {
    const pluginsByAgent = groupBy(snap.agentPlugins, (p) => p.agentId);
    const bindingsByAgent = groupBy(snap.channelBindings, (b) => b.agentId);

    for (const action of plan.actions) {
      try {
        this.runAction(action, pluginsByAgent, bindingsByAgent);
      } catch (err) {
        // T022 — isolate per-action failures so a throw on one Agent never
        // aborts the rest of the diff.
        this.log(`registry: diff action FAILED — skipping`, {
          action: action.kind,
          slug: actionSlug(action),
          error: (err as Error).message,
        });
      }
    }

    if (plan.platformChanged) {
      this.platformSettings = snap.platformSettings;
      this.log(`registry: platform settings updated`, {
        fallbackAgentId: snap.platformSettings.fallbackAgentId,
      });
    }
    this.snapshot = snap;
  }

  private runAction(
    action: DiffAction,
    pluginsByAgent: Map<string, AgentPluginRow[]>,
    bindingsByAgent: Map<string, ChannelBindingRow[]>,
  ): void {
    switch (action.kind) {
      case 'add': {
        const built = buildForAgent(
          action.agent,
          this.deps,
          this.options.defaultRuntimeConfig,
        );
        const plugins = pluginsByAgent.get(action.agent.id) ?? [];
        const bindings = bindingsByAgent.get(action.agent.id) ?? [];
        const memoryScope = computeMemoryScope(action.agent.slug);
        this.active.set(action.agent.slug, {
          agent: action.agent,
          plugins,
          bindings,
          built,
          memoryScope,
        });
        this.notifyBuilt(action.agent.slug, built, 'add');
        this.log(`registry: agent added`, {
          slug: action.agent.slug,
          agentId: action.agent.id,
          plugins: plugins.filter((p) => p.enabled).map((p) => p.pluginId),
          memoryScope,
        });
        return;
      }
      case 'remove': {
        const before = this.active.get(action.slug);
        if (!before) return;
        // The plugin handle's `close()` is what kills per-Agent state —
        // in US4 the orchestrator instance is fully in-memory + GC-owned,
        // so dropping the map entry is enough. The per-(Agent × plugin)
        // PluginContext lifecycle is US8 / future work.
        this.active.delete(action.slug);
        this.log(`registry: agent removed`, {
          slug: action.slug,
          agentId: before.agent.id,
        });
        return;
      }
      case 'rebuild': {
        const before = this.active.get(action.agent.slug);
        const built = buildForAgent(
          action.agent,
          this.deps,
          this.options.defaultRuntimeConfig,
        );
        const plugins = pluginsByAgent.get(action.agent.id) ?? [];
        const bindings = bindingsByAgent.get(action.agent.id) ?? [];
        const memoryScope = computeMemoryScope(action.agent.slug);
        this.active.set(action.agent.slug, {
          agent: action.agent,
          plugins,
          bindings,
          built,
          memoryScope,
        });
        this.notifyBuilt(action.agent.slug, built, 'rebuild');
        this.log(`registry: agent rebuilt`, {
          slug: action.agent.slug,
          agentId: action.agent.id,
          reason: action.reason,
          replaced: !!before,
        });
        return;
      }
      case 'update': {
        const before = this.active.get(action.agent.slug);
        if (!before) return;
        const plugins = pluginsByAgent.get(action.agent.id) ?? [];
        const bindings = bindingsByAgent.get(action.agent.id) ?? [];
        const memoryScope = computeMemoryScope(action.agent.slug);
        this.active.set(action.agent.slug, {
          ...before,
          agent: action.agent,
          plugins,
          bindings,
          memoryScope,
        });
        this.log(`registry: agent metadata updated`, {
          slug: action.agent.slug,
          agentId: action.agent.id,
          plugins: plugins.filter((p) => p.enabled).map((p) => p.pluginId),
          memoryScope,
        });
        return;
      }
    }
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

  /**
   * Attach (or replace) the post-build callback. The orchestrator plugin
   * creates the registry before the kernel has finished collecting its
   * `DomainTool[]` set, so the kernel can't hand the callback at
   * construct time — it calls this method later, once the tool runtime
   * has populated the list. Any subsequent `applySnapshot` / `reload` /
   * `add` / `rebuild` action will fire the new callback.
   */
  setOnAgentBuilt(
    cb: OrchestratorRegistryOptions['onAgentBuilt'],
  ): void {
    this.options = { ...this.options, onAgentBuilt: cb };
  }

  /**
   * Phase A — chat-router fallback resolution. Returns the slug of the
   * Agent currently bound to `platform_settings.fallback_agent_id`, or
   * `undefined` when no fallback is set OR the referenced Agent no
   * longer exists (deleted, disabled, never built). Callers use this
   * as the no-pick default for inbound chat turns.
   */
  slugForFallback(): string | undefined {
    const fallbackId = this.platformSettings.fallbackAgentId;
    if (!fallbackId) return undefined;
    for (const entry of this.active.values()) {
      if (entry.agent.id === fallbackId) return entry.agent.slug;
    }
    return undefined;
  }

  /**
   * Build a per-session `SessionConfigSnapshot` (US6 / T024) from the
   * registry's current view of the named Agent. The session captures this
   * on first use and pins it until a `force-invalidate` clears it.
   *
   * Returns `undefined` when the Agent is not active — the caller decides
   * whether to fall back to the legacy default `chatAgent` or refuse.
   */
  snapshotForAgent(slug: string): SessionConfigSnapshot | undefined {
    const entry = this.active.get(slug);
    if (!entry) return undefined;
    return {
      agentSlug: entry.agent.slug,
      pluginIds: entry.plugins.filter((p) => p.enabled).map((p) => p.pluginId),
      // Tool enumeration is shared at the kernel level until per-Agent
      // plugin activation lands — the empty array means "no per-session
      // tool restriction beyond what the kernel exposes."
      toolIds: [],
      // US8 / T035 — populated from the Agent's computed memory scope.
      memoryScope: [...entry.memoryScope],
      capturedAt: Date.now(),
    };
  }

  /**
   * Resolve the `BuiltOrchestrator` that should serve a given session
   * (US6 / T025). The session's snapshot is the source of truth — the
   * registry just looks up the snapshot's `agentSlug`. If the snapshot
   * points at an Agent that no longer exists (e.g. it was deleted and the
   * session was held open), returns `undefined` and the caller decides.
   */
  lookupForSession(snapshot: SessionConfigSnapshot) {
    const entry = this.active.get(snapshot.agentSlug);
    return entry?.built;
  }

  /**
   * Force-invalidate the snapshot for every chat session whose snapshot
   * binds them to the given Agent (US6 / T026).
   *
   * - `drain` — clear the snapshot. The session keeps its history; the
   *   next turn will re-capture from the current registry state.
   * - `kill`  — delete the session entry entirely.
   *
   * The lookup walks the chatSessionStore's session list; `chatSessionStore`
   * is wired by the caller because the orchestrator plugin owns its
   * lifetime. Returns the number of sessions affected. Best-effort — a
   * per-session failure is logged and skipped.
   */
  async forceInvalidate(
    slug: string,
    mode: 'drain' | 'kill',
    chatSessionStore: ChatSessionStore,
  ): Promise<number> {
    const summaries = await chatSessionStore.list();
    let affected = 0;
    for (const summary of summaries) {
      const session = await chatSessionStore.get(summary.id);
      if (!session?.snapshot) continue;
      if (session.snapshot.agentSlug !== slug) continue;
      try {
        if (mode === 'drain') {
          await chatSessionStore.clearSnapshot(session.id);
        } else {
          await chatSessionStore.delete(session.id);
        }
        affected += 1;
        this.log(`registry: force-invalidate session`, {
          sessionId: session.id,
          slug,
          mode,
        });
      } catch (err) {
        this.log(`registry: force-invalidate session FAILED — skipping`, {
          sessionId: session.id,
          slug,
          mode,
          error: (err as Error).message,
        });
      }
    }
    return affected;
  }

  private log(msg: string, fields?: Record<string, unknown>): void {
    this.options.log?.(msg, fields);
  }

  private notifyBuilt(
    slug: string,
    built: BuiltOrchestrator,
    reason: 'initial' | 'add' | 'rebuild',
  ): void {
    if (!this.options.onAgentBuilt) return;
    try {
      this.options.onAgentBuilt(slug, built, reason);
    } catch (err) {
      this.log(`registry: onAgentBuilt callback threw — continuing`, {
        slug,
        reason,
        error: (err as Error).message,
      });
    }
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

function actionSlug(action: DiffAction): string {
  return action.kind === 'remove' ? action.slug : action.agent.slug;
}

/**
 * Compute an Agent's effective memory scope.
 *
 * STRICT per-orchestrator isolation (supersedes the original US8/T033
 * plugin-union model): an Agent may touch only its own orchestrator tree
 * plus the shared `core` namespace — never another Agent's, and never a
 * shared per-plugin namespace (`agent:<pluginId>:*`). Two Agents that both
 * enable the same plugin therefore do NOT share that plugin's memory; each
 * plugin's notes live under the Agent-private
 * `/memories/orchestrators/<slug>/plugins/<pluginId>/` sub-tree, all covered
 * by the single `orchestrator:<slug>:*` pattern.
 *
 *  - `core`                 — shared agent-agnostic memory (sessions, run
 *                             traces, brand `_*` files, system prompts).
 *  - `orchestrator:<slug>:*` — the Agent's entire private tree.
 *
 * Plugin manifest `permissions.memory` declarations no longer widen an
 * Agent's scope; cross-agent knowledge sharing now flows exclusively through
 * the KG ACL model (team/public-promoted MemorableKnowledge), not the
 * filesystem memory store.
 */
export function computeMemoryScope(agentSlug: string): readonly string[] {
  return orchestratorMemoryScope(agentSlug);
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
