import {
  perCallerService,
  type AgentDirectoryRequest,
  type AgentDirectoryService,
  type AgentDirectoryView,
  type PerCallerFactory,
} from '@omadia/plugin-api';
import { channelUserPrincipal } from '@omadia/channel-sdk';
import {
  ADDRESSABLE_STATUS,
  ChannelResolver,
  ManagementRouter,
  archetypeOf,
  speakerFor,
  type OrchestratorRegistry,
} from '@omadia/orchestrator';

import { effectiveKind, type PluginKind } from '../api/admin-v1.js';

/**
 * Spec 2042 §5.3 / criterion 40 — the agent directory: the agents a person may
 * address in a channel, and what an unaddressed message from them reaches
 * there. ONE source for two surfaces: the session-authenticated route
 * `GET /api/v1/agents/directory` and the `agentDirectory@1` service a channel
 * plugin (the canvas channel's picker) reads — a plugin cannot call the route.
 */

/**
 * The directory for one asker in one channel type. Pure over the registry.
 * Only addressable agents (`enabled`, bindable) that are available to
 * `principal` there; `default_agent` is what an unaddressed message reaches.
 */
export function buildAgentDirectory(
  registry: OrchestratorRegistry,
  query: { readonly channel: string; readonly principal?: string },
): AgentDirectoryView {
  const { channel, principal } = query;
  const view = registry.routingView();
  const router = new ManagementRouter({ view });
  const request = { channelType: channel, ...(principal ? { principal } : {}) };
  const agents = view
    .liveAgents()
    .filter((a) => a.status === ADDRESSABLE_STATUS && a.bindable && router.isAvailable(a, request))
    .map((a) => {
      const row = registry.getById(a.id)?.agent;
      const speaker = row ? speakerFor(row) : undefined;
      return {
        // The agent id: what explicit addressing by id (`resolveAgent`, a
        // canvas turn's `metadata.agentId`) takes.
        id: a.id,
        slug: a.slug,
        display_name: a.displayName,
        short_description: row?.identityShortDescription ?? null,
        avatar_url: speaker?.avatarUrl ?? null,
        archetype: row ? archetypeOf(row) : null,
      };
    })
    .sort((x, y) => x.display_name.localeCompare(y.display_name));
  // What an unaddressed message from this user in this channel reaches: the
  // default agent, or the notice (`off`, unavailable, …).
  const unaddressed = new ChannelResolver({ registry }).resolve(
    channel,
    `directory:${principal ?? 'anonymous'}`,
    principal ? { principal } : {},
  );
  return {
    channel,
    agents,
    default_agent:
      unaddressed.decision === 'bound' && unaddressed.agent
        ? { slug: unaddressed.agent.agent.slug }
        : { slug: null, notice: unaddressed.notice?.code ?? 'no_agent' },
  };
}

export class AgentDirectoryRefusedError extends Error {
  readonly code = 'agent_directory.not_channel';
  constructor(pluginId: string) {
    super(`'agentDirectory' is only given to channel plugins; plugin '${pluginId}' is not one`);
    this.name = 'AgentDirectoryRefusedError';
  }
}

const MAX_FIELD = 320;

/**
 * The principal a channel turn of this asker is routed by: the same form
 * `turnPrincipal` gives the canvas channel's turns (`user:<e-mail>`, else
 * `user:custom:<subject>`), so the picker lists what a turn may reach.
 */
export function directoryPrincipal(request: AgentDirectoryRequest): string | undefined {
  const subject = typeof request.subject === 'string' ? request.subject.trim() : '';
  if (subject.length === 0 || subject.length > MAX_FIELD) return undefined;
  const email = typeof request.email === 'string' ? request.email.slice(0, MAX_FIELD) : undefined;
  return channelUserPrincipal({ kind: 'custom', id: subject, ...(email ? { email } : {}) });
}

/** The service for a registry that may not be there yet (resolved per call). */
export function createAgentDirectoryService(
  registry: () => OrchestratorRegistry | undefined,
): AgentDirectoryService {
  return {
    listAvailable(request: AgentDirectoryRequest): Promise<AgentDirectoryView> {
      const channel = typeof request.channel === 'string' ? request.channel.trim() : '';
      if (channel.length === 0 || channel.length > 64) {
        return Promise.reject(new Error('agent_directory.invalid_channel'));
      }
      const current = registry();
      if (!current) return Promise.reject(new Error('agent_directory.unavailable'));
      const principal = directoryPrincipal(request);
      return Promise.resolve(buildAgentDirectory(current, { channel, ...(principal ? { principal } : {}) }));
    },
  };
}

/** The service as the registry publishes it: per caller, channel plugins only. */
export function agentDirectoryService(
  kindOf: (pluginId: string) => PluginKind | undefined,
  registry: () => OrchestratorRegistry | undefined,
): PerCallerFactory<AgentDirectoryService> {
  const service = createAgentDirectoryService(registry);
  return perCallerService((caller) => {
    const kind = kindOf(caller.pluginId);
    if (kind === undefined || effectiveKind(kind) !== 'channel') {
      throw new AgentDirectoryRefusedError(caller.pluginId);
    }
    return service;
  });
}
