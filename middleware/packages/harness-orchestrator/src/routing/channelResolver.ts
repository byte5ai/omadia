import type { AgentSelectionService, ChatAgent } from '@omadia/channel-sdk';
import type { AgentSpeaker, SystemNotice } from '@omadia/plugin-api';

import { managementChatAgent } from '../management/managementChatAgent.js';
import { speakerFor } from '../management/speakerFor.js';
import { buildSystemNotice } from '../management/systemNotices.js';
import type { ActiveAgent, OrchestratorRegistry } from '../registry/index.js';

import { ManagementRouter, type RoleMembership, type RouteMatch } from './managementRouter.js';

export type { SystemNoticeRequest } from '../management/systemNoticeRequest.js';

/**
 * Channel routing: the management layer's decision for one inbound turn
 * (#2055, #1880; spec 2042 INV-1, INV-6, INV-7, §5.6).
 *
 * A thin, structured-logging wrapper around {@link ManagementRouter}: every
 * decision shows up in the operator's log stream with its match (FR-020).
 *
 * There is no fallback agent. A turn reaches the agent that is addressed,
 * selected, bound or named by the default-agent table, or nobody: then the
 * result is `reject` with the `system` notice the sender gets (the agent is
 * disabled, deleted or not available to them, or nothing addressed an agent).
 * A provisioned bot never answers for another agent; a binding to a disabled
 * agent is not "no binding".
 *
 * The returned `chatAgent` is the management layer in front of the agent
 * (`managementChatAgent`): it handles `/agent <name>`, `/agent` and `/agents`,
 * and on `reject` answers with the notice. It is present on `reject` too.
 */

export type ResolveDecision = 'bound' | 'reject';

export interface ResolveResult {
  readonly decision: ResolveDecision;
  /** Present iff `decision === 'bound'`. */
  readonly agent?: ActiveAgent;
  /**
   * The management layer in front of the routed agent: always present.
   * `/agent` commands are handled here; on `reject` it answers with
   * {@link notice}.
   */
  readonly chatAgent: ChatAgent;
  /** #2045 — with `bound`: the agent that will answer, before it answers. */
  readonly speaker?: AgentSpeaker;
  /**
   * `true` iff the key IS the agent's provisioned identity (its own Teams
   * bot). An adapter probing several keys for one turn MUST prefer an
   * exclusive hit, also an exclusive `reject`, over any other.
   */
  readonly exclusive?: boolean;
  /** What decided. Absent when nothing addressed an agent. */
  readonly match?: RouteMatch;
  /** With `reject`: the `system` notice the sender gets instead of an answer. */
  readonly notice?: SystemNotice;
}

/** Who sent the turn and what they addressed, as far as the channel knows. */
export interface ResolveContext {
  /** The sender, `user:<id>` (channel SDK `formatPrincipal`). */
  readonly principal?: string;
  /** An agent slug the sender addressed explicitly (web chat, API). */
  readonly explicitSlug?: string;
  /** Locale for the notice text (`de`, `en`); German by default. */
  readonly locale?: string;
}

export interface ChannelResolverOptions {
  readonly registry: OrchestratorRegistry;
  readonly log?: (msg: string, fields?: Record<string, unknown>) => void;
  /** Group membership for availability entries `role:<key>`. */
  readonly hasRole?: RoleMembership;
  /** Carries out `/agent` commands (stores the sender's selection). */
  readonly selection?: AgentSelectionService;
}

export class ChannelResolver {
  constructor(private readonly options: ChannelResolverOptions) {}

  /**
   * Resolve one inbound turn. Always emits one structured log line per call
   * (FR-020) so the operator can trace every routing decision.
   */
  resolve(channelType: string, channelKey: string, context: ResolveContext = {}): ResolveResult {
    return this.decide(channelType, channelKey, context);
  }

  /**
   * #2045 / #2059 — explicit addressing by agent id (a canvas, a UI picker):
   * exactly that agent, checked like any routing target, or `reject` with the
   * notice naming it.
   */
  resolveAgent(
    agentId: string,
    target: { readonly channelType: string; readonly channelKey: string },
    context: ResolveContext = {},
  ): ResolveResult {
    return this.decide(target.channelType, target.channelKey, context, agentId);
  }

  private decide(
    channelType: string,
    channelKey: string,
    context: ResolveContext,
    explicitAgentId?: string,
  ): ResolveResult {
    const { registry } = this.options;
    const router = new ManagementRouter({
      view: registry.routingView(),
      ...(this.options.hasRole ? { hasRole: this.options.hasRole } : {}),
    });
    const outcome = router.route({
      channelType,
      channelKey,
      ...(context.principal !== undefined ? { principal: context.principal } : {}),
      ...(context.explicitSlug !== undefined ? { explicitSlug: context.explicitSlug } : {}),
      ...(explicitAgentId !== undefined ? { explicitAgentId } : {}),
    });
    const turn = {
      channelType,
      conversationKey: channelKey,
      ...(context.principal !== undefined ? { principal: context.principal } : {}),
      ...(context.locale !== undefined ? { locale: context.locale } : {}),
      ...(this.options.selection ? { selection: this.options.selection } : {}),
    };
    const exclusive = outcome.match === 'identity';

    if (outcome.kind === 'agent') {
      const active = registry.getById(outcome.agentId);
      if (active) {
        this.log('channelResolver: route', {
          channelType,
          channelKey,
          decision: 'bound',
          match: outcome.match,
          slug: active.agent.slug,
          agentId: active.agent.id,
        });
        const ownBot = exclusive
          ? { ownBotOf: { slug: active.agent.slug, displayName: speakerFor(active.agent).displayName, agentId: active.agent.id } }
          : {};
        return {
          decision: 'bound',
          agent: active,
          chatAgent: managementChatAgent(active.built.bundle.agent, { ...turn, ...ownBot }),
          speaker: speakerFor(active.agent),
          exclusive,
          match: outcome.match,
        };
      }
      // Enabled, but the registry could not build it: the agent named is the
      // one that fails, loudly (INV-7).
      const record = registry.routingView().agentById(outcome.agentId);
      return this.reject(channelType, channelKey, context, turn, {
        code: 'agent_error',
        match: outcome.match,
        exclusive,
        ...(record
          ? { agent: { slug: record.slug, displayName: record.displayName, agentId: record.id } }
          : {}),
      });
    }
    return this.reject(channelType, channelKey, context, turn, {
      code: outcome.code,
      exclusive,
      ...(outcome.match ? { match: outcome.match } : {}),
      ...(outcome.agent ? { agent: outcome.agent } : {}),
    });
  }

  private reject(
    channelType: string,
    channelKey: string,
    context: ResolveContext,
    turn: Parameters<typeof managementChatAgent>[1],
    detail: {
      readonly code: SystemNotice['code'];
      readonly exclusive: boolean;
      readonly match?: RouteMatch;
      readonly agent?: SystemNotice['agent'];
    },
  ): ResolveResult {
    const notice = buildSystemNotice(detail.code, {
      ...(detail.agent ? { agent: detail.agent } : {}),
      ...(context.locale ? { locale: context.locale } : {}),
    });
    this.log('channelResolver: reject', {
      channelType,
      channelKey,
      decision: 'reject',
      notice: detail.code,
      ...(detail.match ? { match: detail.match } : {}),
      ...(detail.agent?.agentId ? { agentId: detail.agent.agentId } : {}),
    });
    return {
      decision: 'reject',
      chatAgent: managementChatAgent(undefined, turn, notice),
      exclusive: detail.exclusive,
      notice,
      ...(detail.match ? { match: detail.match } : {}),
    };
  }

  private log(msg: string, fields?: Record<string, unknown>): void {
    this.options.log?.(msg, fields);
  }
}
