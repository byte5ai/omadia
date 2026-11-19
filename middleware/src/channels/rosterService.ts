// The plugin-facing 'conversationRosters' service (#2043 rollout).
//
// A roster is read AS SOMEBODY: the channel answers with what that bot can
// see. The service used to carry neither an agent nor a channel key, so the
// Teams adapter resolved the conversation reference of the instance's default
// bot. That bot is not in a facilitator's chat, and the first live
// facilitation opened with an empty participant list.
//
// `getRoster(channelType, conversationId, { agentSlug })` now reads the roster
// as that agent's OWN identity. The kernel resolves the channel key; a plugin
// never states one. Two rules keep the option from becoming a way to look
// into chats through somebody else's bot:
//
//   * only the instance's facilitation engine may ask as an agent (it is the
//     plugin that moderates there); any other caller is answered `undefined`;
//   * an agent without an identity on that channel is answered `undefined`,
//     never with another bot's view.
//
// Without the option the call is what it always was.

import { perCallerService } from '@omadia/plugin-api';
import { rosterStatusOf, type ConversationRoster } from '@omadia/channel-sdk';

import { KERNEL_SERVICE_CALLER, type ServiceRegistry } from '../platform/serviceRegistry.js';
import type { ConversationRosterRegistry } from './rosterRegistry.js';

export interface ConversationRosterRequestOptions {
  /** Read the roster as this agent's own channel identity. */
  readonly agentSlug?: string;
  /** #2091 — bypass the channel's cache and ask the platform now. */
  readonly fresh?: boolean;
}

export interface ConversationRostersService {
  getRoster(
    channelType: string,
    conversationId: string,
    opts?: ConversationRosterRequestOptions,
  ): Promise<ConversationRoster | undefined>;
  types(): readonly string[];
}

export interface RosterServiceDeps {
  readonly registry: Pick<ConversationRosterRegistry, 'getRoster' | 'types'>;
  /** The agent's OWN identity on a channel; never the default bot. */
  readonly identityFor: (agentSlug: string, channelType: string) => { channelKey: string } | undefined;
  /** Is this plugin the instance's facilitation engine right now? */
  readonly isEngine: (pluginId: string) => boolean;
  readonly log?: (message: string) => void;
}

/** The service as ONE caller sees it. `callerPluginId` undefined = the kernel. */
export function createConversationRostersService(
  deps: RosterServiceDeps,
  callerPluginId: string | undefined,
): ConversationRostersService {
  // One shape for a plugin: a channel that predates `status` (#2091) gets it
  // derived from `partial`.
  const withStatus = (roster: ConversationRoster | undefined): ConversationRoster | undefined =>
    roster ? { ...roster, status: rosterStatusOf(roster) } : undefined;
  const read = async (
    channelType: string,
    conversationId: string,
    opts: ConversationRosterRequestOptions | undefined,
  ): Promise<ConversationRoster | undefined> => {
      const agentSlug = typeof opts?.agentSlug === 'string' && opts.agentSlug !== '' ? opts.agentSlug : undefined;
      const fresh = opts?.fresh === true ? { fresh: true } : {};
      if (agentSlug === undefined) {
        return opts?.fresh === true
          ? deps.registry.getRoster(channelType, conversationId, fresh)
          : deps.registry.getRoster(channelType, conversationId);
      }
      if (callerPluginId !== undefined && !deps.isEngine(callerPluginId)) {
        deps.log?.(
          `[rosters] '${callerPluginId}' asked for the roster of ${channelType}/${conversationId} as agent '${agentSlug}' — refused: only the facilitation engine reads a roster as an agent`,
        );
        return undefined;
      }
      const identity = deps.identityFor(agentSlug, channelType);
      if (!identity) {
        deps.log?.(
          `[rosters] agent '${agentSlug}' has no identity of its own on '${channelType}' — roster of ${conversationId} unknown`,
        );
        return undefined;
      }
      return deps.registry.getRoster(channelType, conversationId, { asChannelKey: identity.channelKey, ...fresh });
  };
  return {
    types: () => deps.registry.types(),
    getRoster: async (channelType, conversationId, opts) => withStatus(await read(channelType, conversationId, opts)),
  };
}

export function publishConversationRostersService(
  deps: RosterServiceDeps & { readonly serviceRegistry: ServiceRegistry },
): void {
  deps.serviceRegistry.provide(
    'conversationRosters',
    perCallerService((caller) =>
      createConversationRostersService(
        deps,
        caller.pluginId === KERNEL_SERVICE_CALLER.pluginId ? undefined : caller.pluginId,
      ),
    ),
  );
}
