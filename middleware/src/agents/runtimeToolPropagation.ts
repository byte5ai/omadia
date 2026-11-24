/**
 * Per-Agent tool hydration of the multi-orchestrator registry.
 *
 * Every per-Agent orchestrator the registry builds starts without the Agent's
 * DB-defined sub-agent tools (Agent Builder P2/P4); the kernel registers them
 * once the registry exists, again on every rebuild of an Agent, and again on
 * every re-activation of the orchestrator plugin, which publishes a fresh
 * registry.
 *
 * Spec 2042 §5.10 — plugins contribute no domain tools any more. The retired
 * agent runtime exposed one `query_<short>` tool per agent plugin that had to
 * be reconciled across every orchestrator; a capability plugin's tools live in
 * the kernel-wide native tool registry instead and are gated per agent there.
 */

/** The slice of a per-Agent registry entry the hydration reads. */
export interface HydratableAgent {
  readonly agent: { readonly slug: string };
  readonly built: unknown;
}

/** The slice of the per-Agent orchestrator registry the hydration drives. */
export interface HydratableRegistry<B> {
  list(): readonly (HydratableAgent & { readonly built: B })[];
  setOnAgentBuilt(cb: (slug: string, built: B) => void): void;
}

export interface HydrateRegistryDeps<B> {
  /** Registers the Agent's DB-defined sub-agent tools; returns how many. */
  readonly hydrateSubAgentTools: (slug: string, built: B) => number;
  readonly log: (message: string) => void;
}

/**
 * Hydrate every per-Agent orchestrator of `reg` with its sub-agent tools, and
 * install the `onAgentBuilt` hook that keeps a rebuilt Agent hydrated.
 *
 * Runs at boot AND on every re-activation of the orchestrator plugin
 * (provider switch, secret save, reactivate): a re-activation publishes a NEW
 * registry whose orchestrators carry no tools and no hook, so hydrating only
 * the boot instance left every agent without its sub-agents until the next
 * restart. Returns the number of registrations made.
 */
export function hydrateAgentRegistry<B>(
  reg: HydratableRegistry<B>,
  deps: HydrateRegistryDeps<B>,
): number {
  let attached = 0;
  for (const entry of reg.list()) {
    attached += deps.hydrateSubAgentTools(entry.agent.slug, entry.built);
  }
  deps.log(
    `registry orchestrators: hydrated with ${String(attached)} sub-agent tool registrations across ${String(reg.list().length)} agent(s)`,
  );
  // A later `reload()` that REBUILDS an Agent (model_routing / instructions
  // change, …) re-hydrates the new orchestrator.
  reg.setOnAgentBuilt((slug, built) => {
    const subTools = deps.hydrateSubAgentTools(slug, built);
    deps.log(`registry: orchestrator for "${slug}" hydrated with ${String(subTools)} sub-agent tool(s)`);
  });
  return attached;
}

export interface OrchestratorToolRebinderDeps<R> {
  /** The LIVE per-Agent registry (`orchestratorRegistry@1`). */
  readonly getRegistry: () => R | undefined;
  readonly log: (message: string) => void;
}

export interface OrchestratorToolRebinder<R> {
  /** Install the registry hydration (absent on a registry-less host). */
  setRegistryHydrator(hydrate: (reg: R) => void): void;
  /** Re-hydrate the LIVE registry after a re-activation of the orchestrator plugin. */
  rebind(): void;
}

/**
 * The kernel's half of every re-activation of `@omadia/orchestrator`
 * (provider key save, model assignment, OAuth login, setup editor, provider
 * switch — all of them end in `toolPluginRuntime.onActivated`). The plugin
 * publishes a fresh per-Agent registry (#1345, #1400); `rebind` resolves it
 * LIVE and hydrates it, so it works the same on a key-less first boot, where
 * none existed when the kernel wired up (#1358).
 */
export function createOrchestratorToolRebinder<R>(
  deps: OrchestratorToolRebinderDeps<R>,
): OrchestratorToolRebinder<R> {
  let hydrateRegistry: ((reg: R) => void) | undefined;
  return {
    setRegistryHydrator(hydrate) {
      hydrateRegistry = hydrate;
    },
    rebind() {
      const reg = deps.getRegistry();
      if (reg && hydrateRegistry) hydrateRegistry(reg);
      deps.log(
        `orchestrator re-activated — agent tools re-bound (registry=${reg && hydrateRegistry ? 'yes' : 'no'})`,
      );
    },
  };
}
