import type { PluginContext } from '@omadia/plugin-api';

import type { ChatAgent } from './chatAgent.js';

/**
 * Service-registry key under which the orchestrator plugin publishes its
 * ChatAgent. Stable contract — channels resolve the agent by this name.
 */
export const CHAT_AGENT_SERVICE = 'chatAgent';

/**
 * The bundle the orchestrator publishes under {@link CHAT_AGENT_SERVICE}. The
 * SDK only types `agent` (the part channels need to drive turns); the
 * orchestrator's concrete bundle additionally carries kernel-internal handles
 * (raw orchestrator, session logger, chat-session store) that channel plugins
 * should NOT depend on — resolve them yourself if you really need them.
 */
export interface ChatAgentBundle {
  readonly agent: ChatAgent;
}

/**
 * Resolve the orchestrator bundle from a PluginContext, or `undefined` when no
 * orchestrator is installed/active.
 */
export function getChatAgentBundle(ctx: PluginContext): ChatAgentBundle | undefined {
  return ctx.services.get<ChatAgentBundle>(CHAT_AGENT_SERVICE);
}

/**
 * Resolve the orchestrator's {@link ChatAgent} from a PluginContext.
 *
 * The blessed way for a channel to drive a turn when it wants a folded
 * {@link SemanticAnswer} (`agent.chat(input)`) or a live event stream
 * (`agent.chatStream(input)`) — i.e. richer control than the fire-and-forget
 * {@link CoreApi.handleTurnStream}. Returns `undefined` if the orchestrator
 * plugin is not active; callers SHOULD surface a clear
 * "orchestrator unavailable" message rather than silently dropping the turn.
 *
 * @example
 * const agent = getChatAgent(ctx);
 * if (!agent) throw new Error('orchestrator unavailable');
 * const answer = await agent.chat({ userMessage: turn.text, sessionScope, userId });
 */
export function getChatAgent(ctx: PluginContext): ChatAgent | undefined {
  return getChatAgentBundle(ctx)?.agent;
}
