import type { ChatAgentBundle } from '@omadia/channel-sdk';

import type { ChannelManifestBlock } from '../api/admin-v1.js';
import type { TurnDispatcher } from './coreApi.js';
import { resolveDispatchService } from './dispatchService.js';

/**
 * Minimal structural dependencies of the orchestrator dispatcher, injected so
 * the routing logic is unit-testable without standing up the full boot graph.
 * At boot these are backed by `pluginCatalog` and the `serviceRegistry`.
 */
export interface OrchestratorDispatcherDeps {
  /** A loaded channel plugin's manifest `channel` block, by channel id. */
  getChannelBlock(channelId: string): ChannelManifestBlock | undefined;
  /** The ChatAgentBundle registered under a bare service key, or undefined. */
  getAgentBundle(service: string): ChatAgentBundle | undefined;
}

/**
 * Build the real `TurnDispatcher`: per turn, resolve the channel's configured
 * `dispatch_service` (default `chatAgent`), fetch that orchestrator bundle from
 * the registry, and stream its events back. Resolution is lazy per turn so the
 * currently-active orchestrator is always used. Classic channels declare no
 * `dispatch_service` and dispatch to `chatAgent` exactly as before.
 */
export function createOrchestratorDispatcher(
  deps: OrchestratorDispatcherDeps,
): TurnDispatcher {
  return {
    async *streamTurn(input) {
      const dispatchService = resolveDispatchService(
        deps.getChannelBlock(input.channelId),
      );
      const agent = deps.getAgentBundle(dispatchService)?.agent;
      if (!agent) {
        console.warn(
          `[channels] no '${dispatchService}' agent registered — turn ignored (scope=${input.scope})`,
        );
        yield { type: 'error', message: 'orchestrator unavailable' };
        return;
      }
      yield* agent.chatStream({
        userMessage: input.text,
        sessionScope: input.scope,
        userId: input.userRef.id,
      });
    },
  };
}
