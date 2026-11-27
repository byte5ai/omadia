/**
 * #2315 (ADR-0277) — the in-memory twin of `ConfigStore.configRevisions` /
 * `claimConfigRevision` for router tests with a fake config store.
 */
import {
  AGENT_CONFIG_RESOURCES,
  AgentConfigRevisionConflictError,
  type AgentConfigResource,
} from '@omadia/orchestrator';

export class FakeConfigRevisions {
  private readonly byAgent = new Map<string, Map<AgentConfigResource, number>>();

  configRevisions = (agentId: string): Promise<Record<AgentConfigResource, number>> => {
    const stored = this.byAgent.get(agentId);
    const out = {} as Record<AgentConfigResource, number>;
    for (const r of AGENT_CONFIG_RESOURCES) out[r] = stored?.get(r) ?? 0;
    return Promise.resolve(out);
  };

  claimConfigRevision = (
    agentId: string,
    resource: AgentConfigResource,
    expected?: number,
  ): Promise<number> => {
    const stored = this.byAgent.get(agentId) ?? new Map<AgentConfigResource, number>();
    const current = stored.get(resource) ?? 0;
    if (expected !== undefined && expected !== current) {
      return Promise.reject(new AgentConfigRevisionConflictError(resource, expected, current));
    }
    stored.set(resource, current + 1);
    this.byAgent.set(agentId, stored);
    return Promise.resolve(current + 1);
  };
}
