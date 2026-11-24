import type { AgentNamesProvider } from '@omadia/plugin-api';
import { rosterAgentNames } from '@omadia/orchestrator';

/**
 * #2191 / #2192 — the kernel's `agentNames@1`: the names of the roster's
 * agents minus every name an active user bears. The privacy guard never masks
 * them, in a turn (a colleague named in a consultation) or in a background
 * job's stored-text scope. Unknown (no registry yet, human names not loaded)
 * is `null`, which exempts nothing. Both sources are read per call.
 */
export function createAgentNamesProvider(deps: {
  readonly registry: () => { agentNames(): readonly string[] } | undefined;
  readonly humanNames: () => readonly string[] | null;
}): AgentNamesProvider {
  return () => {
    const registry = deps.registry();
    if (registry === undefined) return null;
    return rosterAgentNames({ names: registry.agentNames(), humanNames: deps.humanNames() });
  };
}
