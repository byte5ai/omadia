/**
 * Runtime domain-tool propagation.
 *
 * When an agent-plugin is (de)activated AFTER boot (operator install,
 * Hub/registry install, package re-upload, self-extension), its DomainTool
 * lives only in `dynamicAgentRuntime` and on the single legacy orchestrator.
 * The per-Agent registry orchestrators — which the chat router resolves for
 * every turn, falling back to the fallback Agent for un-slugged turns — are a
 * boot snapshot that the install path historically never reconciled, so the
 * new capability silently never went live without a restart.
 *
 * These two pure helpers carry the reconciliation so the host (index.ts) keeps
 * only the plumbing (resolve the registry/config-store, persist the fallback
 * enablement) and the testable decision logic lives here.
 */

import type { DomainTool } from '@omadia/orchestrator';

import { scopeDomainToolsToPlugins, type AgentPluginScope } from './scopeDomainTools.js';

/** The slice of `Orchestrator` the reconciler mutates. */
export interface DomainToolHost {
  hasDomainTool(name: string): boolean;
  registerDomainTool(tool: DomainTool): void;
  unregisterDomainTool(name: string): boolean;
}

/** One per-Agent orchestrator + whether the plugin under reconciliation is
 *  enabled on that Agent (drives register-vs-withhold). */
export interface ReconcileTarget {
  readonly slug: string;
  readonly enabled: boolean;
  readonly orchestrator: DomainToolHost;
}

export interface ReconcileOptions {
  /** The freshly-activated plugin's DomainTool, or `undefined` when the plugin
   *  exposes none (tool/extension/integration) or was just deactivated. */
  readonly tool?: DomainTool;
  /** On uninstall the runtime no longer knows the tool — drop it by name. */
  readonly removedToolName?: string;
  /** Per-target failure sink; a throw on one Agent never aborts the rest. */
  readonly onError?: (slug: string, err: unknown) => void;
}

/**
 * Reconcile a single agent-plugin's DomainTool across every per-Agent
 * orchestrator:
 *
 *  - `tool` present + enabled on the Agent → (re-)register a fresh handle,
 *    replacing any stale one (safe for version re-uploads).
 *  - `tool` present + NOT enabled → ensure it is absent (plugin withheld).
 *  - `tool` absent + `removedToolName` → drop the named tool (uninstall).
 *
 * Idempotent and isolated: a throw on one target is routed to `onError` and
 * the loop continues.
 */
export function reconcileDomainToolAcrossAgents(
  targets: readonly ReconcileTarget[],
  options: ReconcileOptions,
): void {
  const { tool, removedToolName, onError } = options;
  for (const target of targets) {
    const orch = target.orchestrator;
    try {
      if (tool) {
        if (orch.hasDomainTool(tool.name)) orch.unregisterDomainTool(tool.name);
        if (target.enabled) orch.registerDomainTool(tool);
      } else if (removedToolName && orch.hasDomainTool(removedToolName)) {
        orch.unregisterDomainTool(removedToolName);
      }
    } catch (err) {
      onError?.(target.slug, err);
    }
  }
}

/**
 * Merge the frozen boot-time DomainTool set with the runtime's currently-active
 * set, de-duped by tool name. Boot built-ins are already present in `boot` and
 * win on a name clash. Used to keep per-Agent orchestrator (re)hydration honest
 * after a post-boot install: the boot array alone never sees a hot-installed
 * agent's tool.
 */
export function mergeDomainTools(
  boot: readonly DomainTool[],
  runtime: readonly DomainTool[],
): DomainTool[] {
  const bootNames = new Set(boot.map((t) => t.name));
  return [...boot, ...runtime.filter((t) => !bootNames.has(t.name))];
}

/**
 * The LIVE domain-tool set: the kernel built-ins from the frozen boot set,
 * every dynamic-agent tool from the runtime. The boot set's dynamic-agent
 * entries are boot HANDLES — an agent re-uploaded or upgraded after boot holds
 * a fresh one in the runtime, an uninstalled one none — so they are dropped by
 * name instead of winning a clash, or a (re)hydration would re-bind a stale,
 * already-closed handle or resurrect an uninstalled agent.
 */
export function liveDomainTools(
  boot: readonly DomainTool[],
  dynamicAtBoot: readonly DomainTool[],
  runtimeActive: readonly DomainTool[],
): DomainTool[] {
  return mergeDomainTools(kernelDomainTools(boot, dynamicAtBoot), runtimeActive);
}

/** The boot set without its dynamic-agent entries (see {@link liveDomainTools}). */
export function kernelDomainTools(
  boot: readonly DomainTool[],
  dynamicAtBoot: readonly DomainTool[],
): DomainTool[] {
  const dynamicNames = new Set(dynamicAtBoot.map((t) => t.name));
  return boot.filter((t) => !dynamicNames.has(t.name));
}

/** The slice of a per-Agent registry entry the hydration reads. */
export interface HydratableAgent {
  readonly agent: { readonly slug: string };
  readonly plugins: readonly AgentPluginScope[];
  readonly built: { readonly orchestrator: Pick<DomainToolHost, 'hasDomainTool' | 'registerDomainTool'> };
}

/** The slice of the per-Agent orchestrator registry the hydration drives. */
export interface HydratableRegistry<B extends HydratableAgent['built']> {
  list(): readonly (HydratableAgent & { readonly built: B })[];
  get(slug: string): (HydratableAgent & { readonly built: B }) | undefined;
  setOnAgentBuilt(cb: (slug: string, built: B) => void): void;
}

export interface HydrateRegistryDeps<B> {
  /** The LIVE domain-tool set (boot built-ins merged with runtime installs). */
  readonly currentDomainTools: () => readonly DomainTool[];
  /** Registers the Agent's DB-defined sub-agent tools; returns how many. */
  readonly hydrateSubAgentTools: (slug: string, built: B) => number;
  readonly log: (message: string) => void;
}

function registerScoped(
  orchestrator: HydratableAgent['built']['orchestrator'],
  tools: readonly DomainTool[],
): number {
  let attached = 0;
  for (const t of tools) {
    if (!orchestrator.hasDomainTool(t.name)) {
      orchestrator.registerDomainTool(t);
      attached += 1;
    }
  }
  return attached;
}

function surface(tools: readonly DomainTool[]): string {
  return tools.length === 0
    ? '(none)'
    : tools.map((t) => `${t.name}←${t.agentId ?? 'UNOWNED'}`).join(', ');
}

/**
 * Hydrate every per-Agent orchestrator of `reg` with its plugin-scoped domain
 * tools and sub-agent tools, and install the `onAgentBuilt` hook that keeps a
 * rebuilt Agent hydrated.
 *
 * Runs at boot AND on every re-activation of the orchestrator plugin
 * (provider switch, secret save, reactivate): a re-activation publishes a NEW
 * registry whose orchestrators start with `domainTools: []` and carry no hook,
 * so hydrating only the boot instance left every agent without its
 * sub-agents until the next restart. Idempotent: tools already present are
 * skipped. Returns the number of registrations made.
 */
export function hydrateAgentRegistry<B extends HydratableAgent['built']>(
  reg: HydratableRegistry<B>,
  deps: HydrateRegistryDeps<B>,
): number {
  let attached = 0;
  for (const entry of reg.list()) {
    // By name and by owner, not just a count: a tool that passed the filter
    // for lack of an owner id is indistinguishable from a granted one in a
    // number.
    const scoped = scopeDomainToolsToPlugins(deps.currentDomainTools(), entry.plugins);
    deps.log(`registry: tool surface for "${entry.agent.slug}": ${surface(scoped)}`);
    attached += registerScoped(entry.built.orchestrator, scoped);
    attached += deps.hydrateSubAgentTools(entry.agent.slug, entry.built);
  }
  deps.log(
    `registry orchestrators: hydrated with ${String(attached)} domain-tool registrations across ${String(reg.list().length)} agent(s) (per-Agent plugin-scoped)`,
  );
  // A later `reload()` that REBUILDS an Agent (model_routing / instructions
  // change, …) re-hydrates the new orchestrator from the LIVE tool source. The
  // entry is in the registry map before `onAgentBuilt` fires (both `add` and
  // `rebuild` set it first), so the plugin lookup works here.
  reg.setOnAgentBuilt((slug, built) => {
    const entry = reg.get(slug);
    const tools = entry ? scopeDomainToolsToPlugins(deps.currentDomainTools(), entry.plugins) : [];
    registerScoped(built.orchestrator, tools);
    const subTools = deps.hydrateSubAgentTools(slug, built);
    deps.log(
      `registry: orchestrator for "${slug}" hydrated with ${String(tools.length)} domain-tool(s) + ${String(subTools)} sub-agent tool(s) (per-Agent plugin-scoped): ${surface(tools)}`,
    );
  });
  return attached;
}
