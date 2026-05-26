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
 * Unmatched-key policy (T031):
 *   - If the registry has a `fallback_agent_id` set, the resolver returns
 *     the fallback Agent's `BuiltOrchestrator`. The log line carries
 *     `decision: 'fallback'`.
 *   - Otherwise the resolver returns `undefined`. The channel adapter
 *     must hard-reject the request. The log line carries
 *     `decision: 'reject'`.
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
