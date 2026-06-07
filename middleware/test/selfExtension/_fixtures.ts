/**
 * Shared fixtures for the plugin self-extension test suite. Not a `*.test.ts`
 * so the node:test glob skips it; imported by the suites.
 */
import { parseAgentSpec, type AgentSpec } from '../../src/plugins/builder/agentSpec.js';

/** A read-capable Dynamics agent — the worked example from the design doc.
 *  Holds graph reads+writes scoped to its own namespace, one egress host, one
 *  external read, one sub-agent, a wildcard LLM grant, strict privacy. */
export const BASE_SPEC_INPUT = {
  id: 'de.byte5.agent.dynamics',
  name: 'Dynamics Sales Agent',
  version: '0.1.0',
  description: 'Liest Dataverse-Verkaufsdaten und beantwortet Fragen.',
  category: 'analysis',
  domain: 'dynamics.sales',
  depends_on: ['de.byte5.integration.dynamics'],
  tools: [{ id: 'dynamics_query', description: 'OData query gegen Dataverse', input: {} }],
  skill: { role: 'ein präziser Dataverse-Analyst' },
  playbook: { when_to_use: 'User fragt nach Verkaufszahlen' },
  permissions: {
    graph: {
      entity_systems: ['sales-reports'],
      reads: ['agent:dynamics:*'],
      writes: ['agent:dynamics:*'],
    },
    subAgents: { calls: ['de.byte5.agent.helper'] },
    llm: { models_allowed: ['claude-haiku-4-5*'] },
  },
  network: { outbound: ['api.dynamics.com'] },
  external_reads: [
    { id: 'read_accounts', description: 'Accounts lesen', service: 'dynamics', method: 'query' },
  ],
  privacy_class: 'strict' as const,
};

export function baseSpec(): AgentSpec {
  return parseAgentSpec(BASE_SPEC_INPUT);
}
