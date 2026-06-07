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
