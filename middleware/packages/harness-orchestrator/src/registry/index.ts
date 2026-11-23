import type {
  AgentRuntimeConfig,
  BuiltOrchestrator,
  OrchestratorDeps,
} from '../buildOrchestrator.js';

import type { GuardDirectoryEntry } from '../identityGuard/deterministic.js';
import type { ChatSessionStore, SessionConfigSnapshot } from '../chatSessionStore.js';

import type {
  PersonaSkillRow,
  SkillRow,
  SubAgentRow,
  ToolGrantRow,
} from './agentGraphStore.js';
import {
  buildForAgent,
  diffSnapshots,
  personaSkillsFor,
  type DiffAction,
  type DiffPlan,
} from './applyDiff.js';
import { consultableColleaguesOf } from './consultationColleagues.js';
import { FACILITATOR_ARCHETYPE, isArchetype } from './archetype.js';
import {
  ConfigValidationError,
  type AgentPluginRow,
  type AgentRow,
  type ChannelBindingRow,
  type ChannelIdentityRow,
  type ConfigSnapshot,
  type ConfigStore,
} from './configStore.js';
import type { AgentSelectionRow } from './routingTables.js';
import { SnapshotRoutingView } from './routingView.js';
import { orchestratorMemoryScope } from './scopedMemoryStore.js';
import type { AgentTombstone } from './tombstones.js';

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
   * #2060 — the plugin ids a facilitator-kind agent may be granted: the one
   * installed plugin whose manifest provides the facilitation engine
   * capability, or none. The registry intersects a facilitator's enabled
   * `agent_plugins` rows with this list before it builds, so a row that got
   * in past the write-time refusal (a hand edit, an engine that was since
   * replaced) grants nothing.
   *
   * `undefined` (no lookup wired) and an empty list both mean "nothing".
   */
  facilitatorGrantable?(): readonly string[] | undefined;
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
   * Agent Builder graph (P0/P2): the agent's DB-defined sub-agents, the tool
   * grants targeting the agent or those sub-agents, and the skills those
   * sub-agents reference. Populated from the snapshot on add/rebuild/update so
   * the kernel's `onAgentBuilt` callback can materialise sub-agent domain
   * tools without re-querying the store.
   */
  readonly subAgents: readonly SubAgentRow[];
  readonly toolGrants: readonly ToolGrantRow[];
  readonly skills: readonly SkillRow[];
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
  // JSON encodes the string tuple unambiguously, even when an id contains
  // a separator, quote, or NUL. Replace per snapshot so recovery re-arms logs.
  private quarantinedPluginBindings = new Set<string>();
  /** #2055 — the routing view of the current snapshot, built on demand. */
  private routing: SnapshotRoutingView | undefined;
  private snapshot: ConfigSnapshot | undefined;
  /** #2043 — the grants each active facilitator was BUILT with (see
   *  `withEngineGrantDrift`), by slug. */
  private readonly facilitatorGrants = new Map<string, string>();
  /**
   * Provisioned channel identities from the last snapshot. Flat, not indexed
   * per agent: the lookup is always key → agent and the list is one row per
   * provisioned bot (single digits in practice), so a scan costs less than
   * keeping a second map in sync across four diff actions.
   */
  private channelIdentities: readonly ChannelIdentityRow[] = [];
  /**
   * #2088 — the bindings that point to a DELETED agent, with the tombstone.
   * Kept apart from the active entries (a tombstone is never built), and
   * adopted on every reload like the identities, for the same reason: a
   * delete changes no live agent's row, so the diff can be empty.
   */
  private deletedBindings: readonly { readonly binding: ChannelBindingRow; readonly agent: AgentTombstone }[] = [];

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
    const plan = this.withEngineGrantDrift(diffSnapshots(this.snapshot, safe), safe);
    if (plan.actions.length === 0) {
      // Identities are NOT part of the diff: an agent whose bot finished
      // provisioning has the same row, plugins and bindings it had a minute
      // ago, so the plan is empty and the fast path returns here. Adopting
      // them on this branch too is what makes a bot start routing to its own
      // agent on the next reconcile instead of only after some unrelated
      // config edit forces a rebuild.
      this.channelIdentities = safe.channelIdentities ?? [];
      this.deletedBindings = bindingsOfTombstones(safe);
      this.adoptSnapshot(safe);
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
   * its transition into quarantine; the rest of the snapshot validates and
   * publishes, and the Agent keeps all of its still-installed plugins. This
   * mirrors the per-Agent build isolation (T022) one layer earlier — at the
   * validation gate that runs before the diff.
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
    if (!isInstalled) {
      this.quarantinedPluginBindings.clear();
      return snap;
    }

    const previous = this.quarantinedPluginBindings;
    const quarantined = new Set<string>();
    let newlyQuarantined = 0;
    const agentPlugins = snap.agentPlugins.map((row) => {
      if (!row.enabled) return row;
      if (isInstalled(row.pluginId) !== false) return row;
      const key = JSON.stringify([row.agentId, row.pluginId]);
      if (!previous.has(key) && !quarantined.has(key)) {
        newlyQuarantined += 1;
        this.log(`registry: plugin not installed — disabling binding`, {
          agentId: row.agentId,
          pluginId: row.pluginId,
        });
      }
      quarantined.add(key);
      return { ...row, enabled: false };
    });

    let noLongerQuarantined = 0;
    for (const key of previous) {
      if (!quarantined.has(key)) noLongerQuarantined += 1;
    }
    this.quarantinedPluginBindings = quarantined;
    if (newlyQuarantined > 0 || noLongerQuarantined > 0) {
      // "No longer" also covers removed/disabled bindings, not just plugins
      // that recovered. A changed set can have the same total as before.
      this.log(`registry: quarantined unsatisfiable plugin binding(s)`, {
        newlyQuarantined,
        noLongerQuarantined,
        totalQuarantined: quarantined.size,
      });
    }

    if (quarantined.size === 0) return snap;
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
    const graph = indexGraph(snap);

    for (const action of plan.actions) {
      try {
        this.runAction(action, pluginsByAgent, bindingsByAgent, graph);
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

    this.channelIdentities = snap.channelIdentities ?? [];
    this.deletedBindings = bindingsOfTombstones(snap);
    this.adoptSnapshot(snap);
  }

  /** The snapshot routing reads from; the routing view follows it. */
  private adoptSnapshot(snap: ConfigSnapshot): void {
    this.snapshot = snap;
    this.routing = undefined;
  }

  /**
   * #2055 — what the management layer routes on: every live agent with its
   * status and availability, the tombstones, identities, bindings, selections
   * and default-agent entries of the current snapshot.
   */
  routingView(): SnapshotRoutingView {
    if (!this.routing) this.routing = new SnapshotRoutingView(this.snapshot);
    return this.routing;
  }

  /**
   * #2055 — records a selection the store just wrote, so the sender's next
   * message routes by it even before the reload notification arrives.
   */
  adoptSelection(selection: AgentSelectionRow): void {
    const snap = this.snapshot;
    if (!snap) return;
    const others = this.selectionsWithout(selection.channelType, selection.conversationKey, selection.principal);
    this.adoptSnapshot({ ...snap, selections: [...others, selection] });
  }

  /** #2055 — the counterpart of {@link adoptSelection} for a cleared selection. */
  forgetSelection(channelType: string, conversationKey: string, principal: string): void {
    const snap = this.snapshot;
    if (!snap) return;
    this.adoptSnapshot({ ...snap, selections: this.selectionsWithout(channelType, conversationKey, principal) });
  }

  private selectionsWithout(channelType: string, conversationKey: string, principal: string): AgentSelectionRow[] {
    return (this.snapshot?.selections ?? []).filter(
      (s) => !(s.channelType === channelType && s.conversationKey === conversationKey && s.principal === principal),
    );
  }

  /**
   * #2055 — the instance entry of the default-agent table, when it names an
   * agent the registry serves. `undefined` for `off`, no entry, or an agent
   * that is not enabled or not built. For consumers without a conversation
   * (`chatAgent@1`); conversations route through `ManagementRouter`.
   */
  instanceDefaultSlug(): string | undefined {
    const entry = (this.snapshot?.defaultEntries ?? []).find(
      (e) => e.principal === null && e.channelType === null,
    );
    if (!entry?.agentId) return undefined;
    return this.getById(entry.agentId)?.agent.slug;
  }

  /**
   * The runtime every agent is built with, plus #2046: the directory of all
   * agents' names (live and deleted) the identity guard checks against, read
   * per turn so a renamed colleague is known without a rebuild.
   */
  private runtimeConfig(): Omit<AgentRuntimeConfig, 'agentId'> {
    return {
      ...this.options.defaultRuntimeConfig,
      agentDirectory: () => this.guardDirectory(),
    };
  }

  /** #2046 — every agent's names, for the identity guard. */
  guardDirectory(): GuardDirectoryEntry[] {
    const view = this.routingView();
    const live = view.liveAgents().map((a) => ({ agentId: a.id, slug: a.slug, displayName: a.displayName }));
    const deleted = (this.snapshot?.tombstones ?? []).map((t) => ({
      agentId: t.id,
      slug: t.slug,
      displayName: t.name,
    }));
    return [...live, ...deleted];
  }

  /** The built agent with this id, if the registry serves it. */
  getById(agentId: string): ActiveAgent | undefined {
    for (const entry of this.active.values()) {
      if (entry.agent.id === agentId) return entry;
    }
    return undefined;
  }

  /**
   * The authorisation set an agent is built with: its enabled grant rows.
   * #2060 — for a facilitator, intersected with what the platform says a
   * facilitator may hold (the facilitation engine). No lookup = nothing.
   */
  private grantedPluginIdsFor(
    agent: AgentRow,
    plugins: readonly AgentPluginRow[],
  ): string[] {
    const { granted, dropped } = this.effectiveGrants(agent, plugins);
    if (isArchetype(agent, FACILITATOR_ARCHETYPE)) {
      this.facilitatorGrants.set(agent.slug, granted.join('\n'));
      if (dropped.length > 0) {
        this.log(`registry: facilitator grants ignored (not the facilitation engine)`, {
          slug: agent.slug,
          dropped,
        });
      }
    }
    return granted;
  }

  private effectiveGrants(
    agent: AgentRow,
    plugins: readonly AgentPluginRow[],
  ): { granted: string[]; dropped: string[] } {
    const enabled = plugins.filter((p) => p.enabled).map((p) => p.pluginId);
    const grantable = new Set(this.options.pluginLookup?.facilitatorGrantable?.() ?? []);
    // The engine's tools are for facilitators only; a row on a standard agent
    // (left over from the plugin era, or hand-written) grants nothing.
    if (!isArchetype(agent, FACILITATOR_ARCHETYPE)) {
      return { granted: enabled.filter((id) => !grantable.has(id)), dropped: [] };
    }
    return {
      granted: enabled.filter((id) => grantable.has(id)),
      dropped: enabled.filter((id) => !grantable.has(id)),
    };
  }

  /**
   * #2043 — what a facilitator is built with depends on which plugin is the
   * facilitation engine RIGHT NOW (declared, and granted its SQL ledger by the
   * operator), and that is not in the snapshot. At boot the facilitators are
   * built before the grants can be read, a grant can be given or revoked, an
   * engine can be replaced: the rows stay the same, so the diff is empty and
   * the facilitator kept (or never got) the engine's tools. Every reload
   * therefore re-derives the effective grants of the facilitators it would
   * otherwise leave alone and rebuilds those whose set changed.
   */
  private withEngineGrantDrift(plan: DiffPlan, snap: ConfigSnapshot): DiffPlan {
    const touched = new Set(plan.actions.map((action) => actionSlug(action)));
    const pluginsByAgent = groupBy(snap.agentPlugins, (p) => p.agentId);
    const drifted: DiffAction[] = [];
    for (const agent of snap.agents) {
      if (!isArchetype(agent, FACILITATOR_ARCHETYPE) || touched.has(agent.slug) || !this.active.has(agent.slug)) continue;
      const { granted } = this.effectiveGrants(agent, pluginsByAgent.get(agent.id) ?? []);
      if (this.facilitatorGrants.get(agent.slug) === granted.join('\n')) continue;
      drifted.push({ kind: 'rebuild', agent, reason: 'facilitation_engine' });
    }
    return drifted.length === 0 ? plan : { ...plan, actions: [...plan.actions, ...drifted] };
  }

  private runAction(
    action: DiffAction,
    pluginsByAgent: Map<string, AgentPluginRow[]>,
    bindingsByAgent: Map<string, ChannelBindingRow[]>,
    graph: GraphIndex,
  ): void {
    switch (action.kind) {
      case 'add': {
        // Resolved BEFORE the build: the enabled set is this agent's
        // authorisation, and the orchestrator enforces it at dispatch.
        const plugins = pluginsByAgent.get(action.agent.id) ?? [];
        const built = buildForAgent(
          action.agent,
          this.deps,
          this.runtimeConfig(),
          personaSkillsFor(graph.personaSkillsByAgent.get(action.agent.id) ?? []),
          this.grantedPluginIdsFor(action.agent, plugins),
          consultableColleaguesOf(action.agent.id, graph.snapshot),
        );
        const bindings = bindingsByAgent.get(action.agent.id) ?? [];
        const memoryScope = computeMemoryScope(action.agent.slug);
        this.active.set(action.agent.slug, {
          agent: action.agent,
          plugins,
          bindings,
          built,
          subAgents: graph.subAgentsByAgent.get(action.agent.id) ?? [],
          toolGrants: graph.grantsByAgent.get(action.agent.id) ?? [],
          skills: graph.skillsByAgent.get(action.agent.id) ?? [],
          memoryScope,
        });
        this.notifyBuilt(action.agent.slug, built, 'add');
        this.log(`registry: agent added`, {
          slug: action.agent.slug,
          agentId: action.agent.id,
          plugins: plugins.filter((p) => p.enabled).map((p) => p.pluginId),
          memoryScope,
          effectiveModel: built.effectiveModel,
          ...(built.effectiveModelRouting
            ? { effectiveModelRouting: built.effectiveModelRouting }
            : {}),
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
        this.facilitatorGrants.delete(action.slug);
        this.log(`registry: agent removed`, {
          slug: action.slug,
          agentId: before.agent.id,
        });
        return;
      }
      case 'rebuild': {
        const before = this.active.get(action.agent.slug);
        // Resolved BEFORE the build: the enabled set is this agent's
        // authorisation, and the orchestrator enforces it at dispatch.
        const plugins = pluginsByAgent.get(action.agent.id) ?? [];
        const built = buildForAgent(
          action.agent,
          this.deps,
          this.runtimeConfig(),
          personaSkillsFor(graph.personaSkillsByAgent.get(action.agent.id) ?? []),
          this.grantedPluginIdsFor(action.agent, plugins),
          consultableColleaguesOf(action.agent.id, graph.snapshot),
        );
        const bindings = bindingsByAgent.get(action.agent.id) ?? [];
        const memoryScope = computeMemoryScope(action.agent.slug);
        this.active.set(action.agent.slug, {
          agent: action.agent,
          plugins,
          bindings,
          built,
          subAgents: graph.subAgentsByAgent.get(action.agent.id) ?? [],
          toolGrants: graph.grantsByAgent.get(action.agent.id) ?? [],
          skills: graph.skillsByAgent.get(action.agent.id) ?? [],
          memoryScope,
        });
        this.notifyBuilt(action.agent.slug, built, 'rebuild');
        this.log(`registry: agent rebuilt`, {
          slug: action.agent.slug,
          agentId: action.agent.id,
          reason: action.reason,
          replaced: !!before,
          effectiveModel: built.effectiveModel,
          ...(built.effectiveModelRouting
            ? { effectiveModelRouting: built.effectiveModelRouting }
            : {}),
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
          subAgents: graph.subAgentsByAgent.get(action.agent.id) ?? [],
          toolGrants: graph.grantsByAgent.get(action.agent.id) ?? [],
          skills: graph.skillsByAgent.get(action.agent.id) ?? [],
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
   * The live agent a key belongs to: its provisioned identity, else its
   * `channel_bindings` row. `undefined` when neither names a live agent.
   * There is no fallback agent (#2055): routing decisions with notices go
   * through `ManagementRouter`; this is the plain lookup.
   */
  resolveByChannel(
    channelType: string,
    channelKey: string,
  ): ActiveAgent | undefined {
    const identity = this.identityForChannel(channelType, channelKey);
    if (identity) return identity;
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
    return undefined;
  }

  /**
   * Resolve a key that IS an agent's provisioned identity — its own Teams
   * bot, not a channel someone bound to it.
   *
   * Checked BEFORE `channel_bindings` and reported as exclusive, because a
   * provisioned bot is the one routing input that cannot be ambiguous.
   * Several bots share one group chat, so a binding on that conversation
   * names a chat, not a bot; if it were allowed to win, every bot in the chat
   * would answer as the same agent — which is precisely the failure this
   * exists to prevent. A stale `channel_bindings` row pointing the bot key
   * somewhere else loses for the same reason.
   *
   * Returns `undefined` when the identity names an agent the registry does
   * not hold (deleted, disabled, or failed to build). Routing then continues
   * down the normal path — bindings, then the platform fallback — so an
   * orphaned identity row degrades instead of dead-ending the bot.
   */
  identityForChannel(
    channelType: string,
    channelKey: string,
  ): ActiveAgent | undefined {
    const match = this.channelIdentities.find(
      (i) => i.channelType === channelType && i.channelKey === channelKey,
    );
    if (!match) return undefined;
    for (const entry of this.active.values()) {
      if (entry.agent.id === match.agentId) return entry;
    }
    return undefined;
  }

  /**
   * Is this key a provisioned bot's own identity — WHATEVER state that bot's
   * agent is in?
   *
   * The counterpart of {@link identityForChannel}, and the difference is the
   * whole point: that method answers "which live agent owns this bot", so it
   * returns `undefined` both when the key belongs to nobody AND when it
   * belongs to an agent the registry cannot currently serve (deleted,
   * disabled, failed to build). Those two cases must not be treated alike.
   *
   * A key that belongs to nobody is an unknown channel, and falling back is
   * the right answer. A key that IS a provisioned bot whose agent is missing
   * is a bot with an owner, and answering it from the platform fallback means
   * replying with SOMEBODY ELSE'S PERMISSIONS — the fallback agent is
   * typically granted every installed plugin, so that is a privilege
   * escalation dressed up as resilience. The caller uses this to refuse
   * instead.
   *
   * Returns the owning agent id (useful for the log line) rather than a
   * boolean, so an operator reading the refusal can see which agent is
   * missing without a second lookup.
   */
  /**
   * #2088 — the DELETED agent this conversation is bound to, if any. A
   * binding outlives its agent's deletion (the row is a tombstone), and the
   * conversation must not be answered by somebody else in its place: the
   * resolver refuses the turn. `undefined` = not bound to a deleted agent.
   */
  deletedBindingOwnerFor(channelType: string, channelKey: string): AgentTombstone | undefined {
    return this.deletedBindings.find(
      (d) => d.binding.channelType === channelType && d.binding.channelKey === channelKey,
    )?.agent;
  }

  identityOwnerFor(
    channelType: string,
    channelKey: string,
  ): string | undefined {
    return this.channelIdentities.find(
      (i) => i.channelType === channelType && i.channelKey === channelKey,
    )?.agentId;
  }

  /**
   * WHICH BOT IS THIS AGENT — the reverse of {@link identityForChannel}.
   *
   * Inbound routing asks "whose turn is this key", and both methods above
   * answer that. Speaking asks the opposite question: an agent is about to
   * publish something into a conversation, and it must appear as ITSELF. In a
   * group chat with several provisioned bots, posting through whichever
   * identity happens to be handy makes one bot say another one's words under
   * its own name and avatar — indistinguishable, from the chat, from the
   * agent actually having said it.
   *
   * Returns the agent's provisioned channel identity (for Teams, the
   * `28:<appId>` key), or `undefined` when the agent has none. Callers must
   * treat `undefined` as "this agent cannot speak in its own name here" and
   * refuse — never as licence to borrow another identity.
   *
   * `slug` is matched among the ACTIVE agents: an identity row for an agent
   * the registry cannot serve names a bot nothing is behind.
   */
  channelIdentityFor(
    slug: string,
    channelType: string,
  ): { channelType: string; channelKey: string } | undefined {
    const entry = [...this.active.values()].find((e) => e.agent.slug === slug);
    if (!entry) return undefined;
    const match = this.channelIdentities.find(
      (i) => i.channelType === channelType && i.agentId === entry.agent.id,
    );
    return match ? { channelType: match.channelType, channelKey: match.channelKey } : undefined;
  }

  /** #2043 — the channel types an active agent has an identity of its own on. */
  channelTypesWithIdentity(slug: string): string[] {
    const entry = [...this.active.values()].find((e) => e.agent.slug === slug);
    if (!entry) return [];
    return [
      ...new Set(
        this.channelIdentities.filter((i) => i.agentId === entry.agent.id).map((i) => i.channelType),
      ),
    ].sort();
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
   * Build a per-session `SessionConfigSnapshot` (US6 / T024) from the
   * registry's current view of the named Agent. The session captures this
   * on first use and keeps it until a `force-invalidate` clears it. Only its
   * `agentSlug` routes turns; `pluginIds` is a start-time record, not a pin
   * — a plugin change rebuilds the Agent (`plugin_grants`) and the session's
   * next turn runs on the new set (#1476).
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
   * (US6 / T025) by the snapshot's `agentSlug` — always the Agent's current
   * build, so a rebuild (e.g. `plugin_grants`) applies from the next turn. If the snapshot
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
    const key = `${binding.channelType}\0${binding.channelKey}`;
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

/**
 * Per-agent index of the Agent Builder graph collections in a snapshot, so a
 * diff action can attach an agent's sub-agents / tool grants / referenced
 * skills in O(1). A grant is attributed to an agent when it targets the agent
 * directly (`agentId`) or one of the agent's sub-agents (`subAgentId`).
 */
interface GraphIndex {
  readonly subAgentsByAgent: Map<string, SubAgentRow[]>;
  readonly grantsByAgent: Map<string, ToolGrantRow[]>;
  readonly skillsByAgent: Map<string, SkillRow[]>;
  /** Wave 8 — direct-answer persona skills attached directly to the Agent
   *  (via `agent_persona_skills`), independent of any sub-agent. */
  readonly personaSkillsByAgent: Map<string, SkillRow[]>;
  /** #2047/#2056 — the snapshot the index was built from (colleague names). */
  readonly snapshot: ConfigSnapshot;
}

function indexGraph(snap: ConfigSnapshot): GraphIndex {
  const subAgents = snap.subAgents ?? [];
  const grants = snap.toolGrants ?? [];
  const skills = snap.skills ?? [];
  const personaLinks: readonly PersonaSkillRow[] = snap.personaSkillLinks ?? [];

  const subAgentsByAgent = groupBy(subAgents, (s) => s.parentAgentId);
  const subParent = new Map<string, string>(
    subAgents.map((s) => [s.id, s.parentAgentId]),
  );
  const skillsById = new Map<string, SkillRow>(skills.map((s) => [s.id, s]));

  const personaLinksByAgent = groupBy(personaLinks, (l) => l.agentId);
  const personaSkillsByAgent = new Map<string, SkillRow[]>();
  for (const [agentId, links] of personaLinksByAgent) {
    const resolved: SkillRow[] = [];
    for (const l of links) {
      const sk = skillsById.get(l.skillId);
      if (sk) resolved.push(sk);
    }
    personaSkillsByAgent.set(agentId, resolved);
  }

  const grantsByAgent = new Map<string, ToolGrantRow[]>();
  for (const g of grants) {
    const owner = g.agentId ?? (g.subAgentId ? subParent.get(g.subAgentId) : undefined);
    if (!owner) continue;
    const list = grantsByAgent.get(owner);
    if (list) list.push(g);
    else grantsByAgent.set(owner, [g]);
  }

  const skillsByAgent = new Map<string, SkillRow[]>();
  for (const [agentId, subs] of subAgentsByAgent) {
    const ids = new Set(
      subs.map((s) => s.skillId).filter((id): id is string => !!id),
    );
    const refSkills: SkillRow[] = [];
    for (const id of ids) {
      const sk = skillsById.get(id);
      if (sk) refSkills.push(sk);
    }
    skillsByAgent.set(agentId, refSkills);
  }

  return { subAgentsByAgent, grantsByAgent, skillsByAgent, personaSkillsByAgent, snapshot: snap };
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

/** The bindings of a snapshot whose agent is a tombstone. */
function bindingsOfTombstones(
  snap: ConfigSnapshot,
): { readonly binding: ChannelBindingRow; readonly agent: AgentTombstone }[] {
  const tombstones = new Map((snap.tombstones ?? []).map((t) => [t.id, t]));
  if (tombstones.size === 0) return [];
  return snap.channelBindings.flatMap((binding) => {
    const agent = tombstones.get(binding.agentId);
    return agent ? [{ binding, agent }] : [];
  });
}
