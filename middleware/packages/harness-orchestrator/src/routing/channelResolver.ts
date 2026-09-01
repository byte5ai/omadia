import type { ChatAgent } from '@omadia/channel-sdk';

import type { ActiveAgent, OrchestratorRegistry } from '../registry/index.js';

/**
 * Channel routing (US7 / T028).
 *
 * Resolves an inbound webhook (channel type + channel key) to the owning
 * Agent's `BuiltOrchestrator` via the live `OrchestratorRegistry`. The
 * resolver is a thin, structured-logging wrapper around the registry's
 * `resolveByChannel` so the routing decision shows up in the operator's
 * log stream with full context (FR-020) — the registry itself stays
 * routing-agnostic so unit tests don't have to assert on log lines.
 *
 * Precedence (highest first):
 *   1. PROVISIONED IDENTITY — the key is an agent's own bot
 *      (`agent_teams_identities.app_id` → `28:<appId>`). Reported as
 *      `decision: 'bound', exclusive: true`. This rank exists because a
 *      channel adapter probes several keys per turn and the less specific
 *      ones are genuinely ambiguous: many provisioned bots live in one group
 *      chat, so a binding on that conversation cannot say which bot a turn
 *      belongs to. Letting it win made every bot answer as the same agent.
 *   2. A provisioned identity whose agent is NOT servable — `decision:
 *      'reject'`, and deliberately not a fallback. See below.
 *   3. `channel_bindings` — what the operator bound. `decision: 'bound'`.
 *   4. The platform fallback Agent. `decision: 'fallback'`.
 *   5. Nothing. `decision: 'reject'`.
 *
 * Unmatched-key policy (T031):
 *   - If the registry has a `fallback_agent_id` set, the resolver returns
 *     the fallback Agent's `BuiltOrchestrator`. The log line carries
 *     `decision: 'fallback'`.
 *   - Otherwise the resolver returns `undefined`. The channel adapter
 *     must hard-reject the request. The log line carries
 *     `decision: 'reject'`.
 *
 * THE ONE KEY THAT MAY NOT FALL BACK is a provisioned bot's own identity.
 * "Unknown channel" and "this bot's agent is missing" used to reach the
 * fallback by the same route, and they are not the same question: the second
 * has an owner, and the fallback agent is typically granted every installed
 * plugin. Answering there means a bot replies under its own name with
 * permissions its agent was never given, which no one in the chat can see.
 * Rank 2 exists to refuse that case instead.
 *
 * The legacy single-Agent boot path keeps using `chatAgent@1` directly;
 * adopting the resolver is an opt-in for channel plugins that want
 * per-binding routing (US7).
 */

export type ResolveDecision = 'bound' | 'fallback' | 'reject';

export interface ResolveResult {
  readonly decision: ResolveDecision;
  /** Present iff `decision !== 'reject'`. */
  readonly agent?: ActiveAgent;
  /** Convenience: same as `agent?.built.bundle.agent` when present. */
  readonly chatAgent?: ChatAgent;
  /**
   * `true` iff the key IS the agent's provisioned identity (its own Teams
   * bot), rather than a binding someone chose. Additive and optional: a
   * channel adapter that ignores it keeps its previous behaviour exactly.
   *
   * An adapter that holds several keys for one turn — Teams sends both a
   * conversation id and the bot's `28:<appId>` — MUST prefer an exclusive
   * hit over any other, whatever order it probes in. Without that, a binding
   * on the group chat all the bots share silently answers for every one of
   * them.
   */
  readonly exclusive?: boolean;
}

export interface ChannelResolverOptions {
  readonly registry: OrchestratorRegistry;
  readonly log?: (msg: string, fields?: Record<string, unknown>) => void;
}

export class ChannelResolver {
  constructor(private readonly options: ChannelResolverOptions) {}

  /**
   * Resolve a webhook → Agent. Always emits one structured log line per
   * call (FR-020) so the operator can trace every routing decision.
   */
  resolve(channelType: string, channelKey: string): ResolveResult {
    const registry = this.options.registry;
    // A provisioned identity outranks every binding — see
    // `OrchestratorRegistry.identityForChannel`. Reported separately from
    // the binding path so the log line names WHY the turn went where it did:
    // "fell back" and "is that bot's agent" are very different answers to
    // the same operator question.
    const identity = registry.identityForChannel(channelType, channelKey);
    if (identity) {
      this.log(`channelResolver: route`, {
        channelType,
        channelKey,
        decision: 'bound',
        match: 'identity',
        slug: identity.agent.slug,
        agentId: identity.agent.id,
      });
      return {
        decision: 'bound',
        agent: identity,
        chatAgent: identity.built.bundle.agent,
        exclusive: true,
      };
    }
    // A PROVISIONED BOT NEVER FALLS BACK.
    //
    // Reaching here with a key that IS an agent's own bot means that agent is
    // not currently servable — deleted, disabled, or it failed to build. The
    // old behaviour let routing continue to bindings and then to the platform
    // fallback, which reads as graceful degradation and is not: the fallback
    // agent is typically granted EVERY installed plugin, so a bot whose own
    // agent holds nothing would answer with HR, accounting and every other
    // integration behind its own name. The person in the chat sees the bot
    // they addressed and has no way to know they are talking to something
    // else with different permissions.
    //
    // Refusing is the honest outcome and the safe one: the bot goes quiet,
    // which is visible and fixable, instead of answering beyond its rights,
    // which is neither. Only keys that belong to NO provisioned bot may fall
    // back — an unknown channel has no owner whose permissions could be
    // exceeded.
    const identityOwner = registry.identityOwnerFor(channelType, channelKey);
    if (identityOwner !== undefined) {
      this.log(`channelResolver: reject`, {
        channelType,
        channelKey,
        decision: 'reject',
        match: 'identity-unavailable',
        agentId: identityOwner,
      });
      return { decision: 'reject' };
    }
    const direct = registry.resolveByChannel(channelType, channelKey);
    if (direct) {
      // The registry's resolveByChannel returns the fallback too when no
      // direct binding matches — distinguish here so the log line is honest.
      const isDirect = direct.bindings.some(
        (b) =>
          b.channelType === channelType && b.channelKey === channelKey,
      );
      const decision: ResolveDecision = isDirect ? 'bound' : 'fallback';
      this.log(`channelResolver: route`, {
        channelType,
        channelKey,
        decision,
        match: decision === 'bound' ? 'binding' : 'fallback',
        slug: direct.agent.slug,
        agentId: direct.agent.id,
      });
      return {
        decision,
        agent: direct,
        chatAgent: direct.built.bundle.agent,
      };
    }
    this.log(`channelResolver: reject`, {
      channelType,
      channelKey,
      decision: 'reject',
    });
    return { decision: 'reject' };
  }

  private log(msg: string, fields?: Record<string, unknown>): void {
    this.options.log?.(msg, fields);
  }
}
