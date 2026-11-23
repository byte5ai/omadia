import { setModelCallHalts } from '@omadia/usage-telemetry';

import type { ExecutionScopeStore } from './scopeStore.js';

/**
 * Spec 2042 §5.10, ADR-0017 — the kill switch applies to every model call.
 *
 * Kill switches live in the database (`execution_kill_switches`, #2090);
 * the model gateway's gate runs synchronously in every provider call. This
 * mirror copies the switches that are on into the gate: an instance switch
 * halts every model call, an agent switch every call in that agent's turns
 * and scopes. A process switch stays with the execution authorization,
 * which already refuses that process's actions.
 *
 * Refreshed right after an operator sets or clears a switch on this machine,
 * and on an interval for switches set through another machine.
 */
export interface ModelCallHaltMirror {
  refresh(): Promise<void>;
  /** Start the interval refresh; returns the stop. */
  start(intervalMs: number): () => void;
}

export function createModelCallHaltMirror(deps: {
  readonly store: () => Pick<ExecutionScopeStore, 'listKillSwitches'> | undefined;
  /** Slugs of live agents by id. */
  readonly agentSlugs: () => Promise<ReadonlyMap<string, string>>;
  readonly log?: (message: string) => void;
}): ModelCallHaltMirror {
  let failing = false;
  const refresh = async (): Promise<void> => {
    const store = deps.store();
    if (!store) return;
    try {
      const switches = await store.listKillSwitches();
      const instance = switches.find((k) => k.level === 'instance');
      const agentSwitches = switches.filter((k) => k.level === 'agent' && k.agentId !== undefined);
      const slugs = agentSwitches.length > 0 ? await deps.agentSlugs() : new Map<string, string>();
      const agents = new Map<string, string>();
      for (const k of agentSwitches) {
        const slug = slugs.get(k.agentId as string);
        if (slug !== undefined) agents.set(slug, k.reason || 'kill switch');
      }
      setModelCallHalts({ instance: instance ? instance.reason || 'kill switch' : undefined, agents });
      if (failing) deps.log?.('[model-gateway] kill switches readable again');
      failing = false;
    } catch (err) {
      // The last known halts stay in place: a database hiccup must not lift
      // a switch an operator set.
      if (!failing) {
        deps.log?.(
          `[model-gateway] reading the kill switches failed, keeping the last known state: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      failing = true;
    }
  };
  return {
    refresh,
    start(intervalMs) {
      void refresh();
      const timer = setInterval(() => void refresh(), intervalMs);
      timer.unref();
      return () => clearInterval(timer);
    },
  };
}
