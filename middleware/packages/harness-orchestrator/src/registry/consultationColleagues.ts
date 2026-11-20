/**
 * Spec 2042 §5.4 / #2056 — the colleagues an agent may consult, by name, for
 * its prompt (`consultableColleagues`). Read from the registry snapshot so a
 * changed grant, switch or name rebuilds the agent (`applyDiff`
 * `consultation_colleagues`).
 */

import type { AgentRow, ConfigSnapshot, ConsultationPairRow } from './configStore.js';

const FACILITATOR = 'facilitator';

function displayName(agent: AgentRow): string {
  return agent.identityName?.trim() || agent.name;
}

/** The names of the agents `agentId` may consult: active pair, live, not a facilitator. */
export function consultableColleaguesOf(agentId: string, snap: ConfigSnapshot | undefined): string[] {
  const pairs: readonly ConsultationPairRow[] = snap?.consultationPairs ?? [];
  if (pairs.length === 0) return [];
  const byId = new Map((snap?.agents ?? []).map((a) => [a.id, a]));
  const self = byId.get(agentId);
  if (!self || self.archetype === FACILITATOR) return [];
  const names = new Set<string>();
  for (const pair of pairs) {
    if (pair.fromAgentId !== agentId) continue;
    const colleague = byId.get(pair.toAgentId);
    if (!colleague || colleague.archetype === FACILITATOR || colleague.status !== 'enabled') continue;
    names.add(displayName(colleague));
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}
