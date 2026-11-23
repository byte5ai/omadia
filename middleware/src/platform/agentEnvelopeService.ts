import {
  perCallerService,
  type AgentEnvelope,
  type AgentEnvelopeResolver,
  type PerCallerFactory,
} from '@omadia/plugin-api';

import { effectiveKind, type PluginKind } from '../api/admin-v1.js';

/**
 * Spec 2042 §5.2 / INV-7 — `agentEnvelope@1`: the envelope of ONE agent, by
 * `agents.id`, for a system module that works on that agent's behalf (the
 * canvas presentation helper). A pure lookup in the agent registry: no model,
 * no routing decision (the channel already checked that the user may reach
 * the agent). An agent that cannot serve — unknown, not enabled, not built —
 * has no envelope, and nothing else is ever handed out in its place.
 */

/** What the resolver needs of the agent registry. */
export interface AgentEnvelopeSource<TAgent> {
  getById(agentId: string):
    | {
        readonly agent: { readonly id: string; readonly status: string };
        readonly built: { readonly bundle: { readonly agent: TAgent } };
      }
    | undefined;
}

export class AgentEnvelopeRefusedError extends Error {
  readonly code = 'agent_envelope.not_system_module';
  constructor(pluginId: string) {
    super(`'agentEnvelope' is only given to system modules; plugin '${pluginId}' is not one`);
    this.name = 'AgentEnvelopeRefusedError';
  }
}

export function createAgentEnvelopeResolver<TAgent>(
  source: () => AgentEnvelopeSource<TAgent> | undefined,
): AgentEnvelopeResolver<TAgent> {
  return {
    resolve(agentId: string): AgentEnvelope<TAgent> | undefined {
      if (typeof agentId !== 'string' || agentId.trim().length === 0) return undefined;
      const active = source()?.getById(agentId);
      if (!active || active.agent.id !== agentId || active.agent.status !== 'enabled') return undefined;
      return { agentId: active.agent.id, agent: active.built.bundle.agent };
    },
  };
}

/** The service as the registry publishes it: per caller, system modules only. */
export function agentEnvelopeService<TAgent>(
  kindOf: (pluginId: string) => PluginKind | undefined,
  source: () => AgentEnvelopeSource<TAgent> | undefined,
): PerCallerFactory<AgentEnvelopeResolver<TAgent>> {
  const resolver = createAgentEnvelopeResolver(source);
  return perCallerService((caller) => {
    const kind = kindOf(caller.pluginId);
    if (kind === undefined || effectiveKind(kind) !== 'system-module') {
      throw new AgentEnvelopeRefusedError(caller.pluginId);
    }
    return resolver;
  });
}
