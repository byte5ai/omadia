import type { PluginContext } from '@omadia/plugin-api';

import type { ChatAgent } from './chatAgent.js';
import { getChatAgent } from './chatAgentService.js';

/**
 * Per-binding channel routing seam (US7).
 *
 * The platform's multi-orchestrator registry builds one *scoped* orchestrator
 * per Agent — each carrying only the domain tools its enabled plugins grant.
 * Inbound channel turns must reach the Agent the operator *bound* to their
 * `(channel_type, channel_key)`, not the shared, fully-tooled `chatAgent`
 * singleton. The orchestrator plugin publishes a {@link ChannelBindingResolver}
 * under {@link CHANNEL_RESOLVER_SERVICE} that does exactly that lookup.
 *
 * A channel adapter that holds a *single* agent across many conversations
 * (Teams, Telegram) must therefore resolve the agent **per turn** — keyed by
 * the conversation's `(channelType, channelKey)` — rather than caching
 * `getChatAgent(ctx)` once at activate(). {@link resolveChatAgentForChannel}
 * is the blessed way to do that: it consults the resolver and degrades to the
 * shared singleton when no binding (and no platform fallback Agent) matches, so
 * deployments without the multi-orchestrator registry behave exactly as before.
 */

/**
 * Service-registry key under which the orchestrator plugin publishes its
 * channel resolver. Stable contract — channels resolve it by this name.
 */
export const CHANNEL_RESOLVER_SERVICE = 'channelResolver';

export type ChannelResolveDecision = 'bound' | 'fallback' | 'reject';

/** What {@link ChannelBindingResolver.resolve} returns for a lookup. */
export interface ChannelResolveResult {
  readonly decision: ChannelResolveDecision;
  /**
   * The bound (or platform-fallback) Agent's scoped {@link ChatAgent}. Present
   * iff `decision !== 'reject'`.
   */
  readonly chatAgent?: ChatAgent;
  /**
   * `true` iff the key IS the agent's provisioned identity — the bot that
   * was registered to BE this agent — rather than a binding an operator (or
   * the auto-bind sweep) chose for it.
   *
   * Only matters for an adapter that probes MORE THAN ONE key per turn.
   * Teams has two: the conversation the message arrived in, and the bot's own
   * `28:<appId>`. Several provisioned bots can share one group chat, so a hit
   * on the conversation identifies the chat, never the bot — prefer an
   * exclusive hit over any other, no matter which key you probed first.
   *
   * Optional and additive. Older platforms never set it and adapters that
   * ignore it behave exactly as they did before.
   */
  readonly exclusive?: boolean;
}

/**
 * Structural view of the orchestrator's `ChannelResolver` — the only surface a
 * channel plugin consumes. Kept structural so the SDK does not take a build
 * dependency on `@omadia/orchestrator`.
 */
export interface ChannelBindingResolver {
  resolve(channelType: string, channelKey: string): ChannelResolveResult;
}

/**
 * Resolve the {@link ChatAgent} bound to a given `(channelType, channelKey)`
 * via the platform {@link CHANNEL_RESOLVER_SERVICE}, falling back to the shared
 * singleton agent ({@link getChatAgent}) when:
 *   - the resolver service is not published (no multi-orchestrator registry —
 *     e.g. a Postgres-less minimal deployment), or
 *   - the resolver rejects the route (no binding AND no platform fallback
 *     Agent configured).
 *
 * Call this **per turn**. A channel adapter that caches the result at
 * activate() defeats per-binding routing and hot config reloads — the whole
 * point of the seam.
 *
 * Returns `undefined` only when neither a bound agent nor the singleton is
 * available (orchestrator plugin inactive); callers SHOULD surface a clear
 * "orchestrator unavailable" message rather than silently dropping the turn.
 *
 * @example
 * // Teams: channelType is constant for the plugin; channelKey is the
 * // conversation id the operator binds in the dashboard.
 * const agent = resolveChatAgentForChannel(ctx, 'teams', conversationId);
 * if (!agent) throw new Error('orchestrator unavailable');
 * const answer = await agent.chat({ userMessage, sessionScope, userId });
 */
export function resolveChatAgentForChannel(
  ctx: PluginContext,
  channelType: string,
  channelKey: string,
): ChatAgent | undefined {
  const resolver = ctx.services.get<ChannelBindingResolver>(
    CHANNEL_RESOLVER_SERVICE,
  );
  if (resolver) {
    const result = resolver.resolve(channelType, channelKey);
    if (result.decision !== 'reject' && result.chatAgent) {
      return result.chatAgent;
    }
  }
  return getChatAgent(ctx);
}
