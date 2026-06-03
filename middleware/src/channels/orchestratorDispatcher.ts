import { CHAT_AGENT_SERVICE } from '@omadia/channel-sdk';
import type { ChatAgent, ChatAgentBundle } from '@omadia/channel-sdk';

import type { ChannelManifestBlock } from '../api/admin-v1.js';
import type { TurnDispatcher } from './coreApi.js';
import { resolveDispatchService } from './dispatchService.js';

/**
 * Minimal structural dependencies of the orchestrator dispatcher, injected so
 * the routing logic is unit-testable without standing up the full boot graph.
 * At boot these are backed by `pluginCatalog`, the multi-orchestrator
 * `channelResolver`, and the `serviceRegistry`.
 */
export interface OrchestratorDispatcherDeps {
  /** A loaded channel plugin's manifest `channel` block, by channel id. */
  getChannelBlock(channelId: string): ChannelManifestBlock | undefined;
  /** The ChatAgentBundle registered under a bare service key, or undefined. */
  getAgentBundle(service: string): ChatAgentBundle | undefined;
  /**
   * US7 per-binding routing: resolve the *scoped* ChatAgent bound to a turn's
   * `(channelType, channelKey)` via the multi-orchestrator `channelResolver`.
   * Returns `undefined` when no binding (and no platform fallback Agent)
   * matches, OR when the resolver is not wired (Postgres-less deployment) — the
   * dispatcher then falls back to the static `dispatch_service`. Optional so the
   * legacy single-Agent boot and unit tests work without it.
   */
  resolveBinding?(channelType: string, channelKey: string): ChatAgent | undefined;
  /**
   * Map a `channelId` (plugin catalog id) to its `channel_bindings.channel_type`
   * selector (`de.byte5.channel.teams` → `teams`). Optional — paired with
   * `resolveBinding`; absent disables per-binding routing.
   */
  channelTypeFor?(channelId: string): string;
}

/**
 * Build the real `TurnDispatcher`. Per turn:
 *
 *   1. **Per-binding routing (US7).** When the channel routes to the shared
 *      `chatAgent` (i.e. declares no explicit `dispatch_service`) and a
 *      `channelKey` is known, resolve the Agent the operator *bound* to this
 *      `(channelType, channelKey)` via the `channelResolver`. This is what
 *      makes a Teams/web turn reach its scoped orchestrator instead of the
 *      fully-tooled singleton.
 *   2. **Static dispatch_service fallback.** No binding match (or no resolver,
 *      or an explicit `dispatch_service` like Omadia UI's `canvasChatAgent`) →
 *      fetch that bundle from the registry exactly as before. An explicit
 *      `dispatch_service` is an intentional override and is NEVER re-routed by
 *      the binding resolver.
 *
 * Resolution is lazy per turn so the currently-active orchestrator (and the
 * live binding table, post hot-reload) is always used. Classic channels with no
 * bindings and no `dispatch_service` dispatch to `chatAgent` exactly as before.
 */
export function createOrchestratorDispatcher(
  deps: OrchestratorDispatcherDeps,
): TurnDispatcher {
  return {
    async *streamTurn(input) {
      const block = deps.getChannelBlock(input.channelId);
      const dispatchService = resolveDispatchService(block);

      let agent: ChatAgent | undefined;

      // (1) Per-binding routing — only for channels that would otherwise hit
      // the shared chatAgent. An explicit dispatch_service (canvas) opts out.
      if (
        dispatchService === CHAT_AGENT_SERVICE &&
        deps.resolveBinding &&
        deps.channelTypeFor &&
        input.channelKey
      ) {
        const channelType =
          input.channelType ?? deps.channelTypeFor(input.channelId);
        agent = deps.resolveBinding(channelType, input.channelKey);
      }

      // (2) Static dispatch_service fallback (legacy + canvas).
      if (!agent) {
        agent = deps.getAgentBundle(dispatchService)?.agent;
      }

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
