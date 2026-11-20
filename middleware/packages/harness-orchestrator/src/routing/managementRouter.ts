/**
 * The management layer's routing (#2055, #1880; spec 2042 INV-1, INV-6,
 * INV-7, §5.3, §5.6). Deterministic, no model: which agent a turn belongs to,
 * or which `system` notice the sender gets instead.
 *
 * Order, the first that applies decides:
 *   1. the agent's own channel identity (its bot) — explicit addressing;
 *   2. an explicit address in the turn (web chat or API slug);
 *   3. the sender's stored selection for this conversation;
 *   4. the conversation's binding;
 *   5. the default-agent table: (user, channel), (user), (channel), instance;
 *      the first entry that exists wins, `off` included;
 *   6. nothing: `no_agent`.
 *
 * Whatever names an agent, that agent answers or nobody does: a disabled,
 * deleted or unavailable target gives a notice naming it (INV-7), never
 * another agent. Only an agent with status `enabled` is addressable; every
 * other status (`disabled`, `draft`, anything added later) is not.
 */

import type { NoticeAgentRef, SystemNoticeCode } from '@omadia/plugin-api';

import type { DefaultAgentEntryRow } from '../registry/routingTables.js';

/** The one addressable status. Everything else is not addressable. */
export const ADDRESSABLE_STATUS = 'enabled';

/** What routing knows about an agent, live or deleted. */
export interface RoutingAgentRecord {
  readonly id: string;
  readonly slug: string;
  /** The name it wears (identity display name, else the registry name). */
  readonly displayName: string;
  readonly status: string;
  readonly deleted: boolean;
  readonly availableToEveryone: boolean;
  /** Channel types it serves; null = all. */
  readonly availableChannels: readonly string[] | null;
  /** Named people (`user:<id>`) and groups (`role:<key>`). */
  readonly availablePrincipals: readonly string[];
  /** False when the archetype omits being reached through a binding (facilitator). */
  readonly bindable: boolean;
  /** False when the archetype omits the default-agent role (facilitator). */
  readonly defaultable: boolean;
}

/** The registry's routing data, as routing needs it. */
export interface RoutingView {
  agentById(id: string): RoutingAgentRecord | undefined;
  /** A live agent by slug, else a deleted one that had this slug. */
  agentBySlug(slug: string): RoutingAgentRecord | undefined;
  /** The agent whose provisioned identity this key is, whatever its state. */
  identityOwner(channelType: string, channelKey: string): string | undefined;
  /** The agent bound to this conversation, whatever its state. */
  bindingOwner(channelType: string, channelKey: string): string | undefined;
  selectionOwner(channelType: string, conversationKey: string, principal: string): string | undefined;
  defaultEntries(): readonly DefaultAgentEntryRow[];
}

export interface RouteRequest {
  readonly channelType: string;
  /** The conversation (channel key). */
  readonly channelKey: string;
  /** The sender, `user:<id>`, when the channel names one. */
  readonly principal?: string;
  /** An explicit address in the turn: the agent slug the sender chose. */
  readonly explicitSlug?: string;
  /** An explicit address by agent id (a canvas or UI picker, #2059). */
  readonly explicitAgentId?: string;
}

export type RouteMatch = 'identity' | 'explicit' | 'selection' | 'binding' | 'default';

export type RouteOutcome =
  | {
      readonly kind: 'agent';
      readonly agentId: string;
      readonly slug: string;
      readonly match: RouteMatch;
      /** True for the agent's own identity: an adapter probing several keys prefers it. */
      readonly exclusive: boolean;
    }
  | {
      readonly kind: 'notice';
      readonly code: SystemNoticeCode;
      readonly agent?: NoticeAgentRef;
      /** What led to the notice; absent for `no_agent`. */
      readonly match?: RouteMatch;
    };

/** Decides whether the sender holds a group (`role:<key>`). */
export type RoleMembership = (principal: string, roleKey: string) => boolean;

export interface ManagementRouterOptions {
  readonly view: RoutingView;
  readonly hasRole?: RoleMembership;
}

function ref(agent: RoutingAgentRecord): NoticeAgentRef {
  return { slug: agent.slug, displayName: agent.displayName, agentId: agent.id };
}

export class ManagementRouter {
  constructor(private readonly options: ManagementRouterOptions) {}

  route(request: RouteRequest): RouteOutcome {
    const { view } = this.options;
    const { channelType, channelKey, principal } = request;

    const identity = view.identityOwner(channelType, channelKey);
    if (identity !== undefined) return this.serve(identity, 'identity', request, true);

    if (request.explicitAgentId !== undefined) {
      return this.serve(request.explicitAgentId, 'explicit', request, false);
    }

    if (request.explicitSlug !== undefined) {
      const agent = view.agentBySlug(request.explicitSlug);
      if (!agent) {
        return {
          kind: 'notice',
          code: 'agent_unknown',
          agent: { slug: request.explicitSlug, displayName: request.explicitSlug },
          match: 'explicit',
        };
      }
      return this.serveRecord(agent, 'explicit', request, false);
    }

    if (principal !== undefined) {
      const selected = view.selectionOwner(channelType, channelKey, principal);
      if (selected !== undefined) return this.serve(selected, 'selection', request, false);
    }

    const bound = view.bindingOwner(channelType, channelKey);
    if (bound !== undefined) return this.serve(bound, 'binding', request, false);

    const entry = defaultEntryFor(view.defaultEntries(), principal, channelType);
    if (entry && entry.agentId !== null) return this.serve(entry.agentId, 'default', request, false);
    return { kind: 'notice', code: 'no_agent' };
  }

  private serve(agentId: string, match: RouteMatch, request: RouteRequest, exclusive: boolean): RouteOutcome {
    const agent = this.options.view.agentById(agentId);
    if (!agent) {
      // A reference to a row routing does not hold (purged between reloads):
      // nobody is named, so nobody answers.
      return { kind: 'notice', code: 'agent_unknown', agent: { slug: agentId, displayName: agentId, agentId }, match };
    }
    return this.serveRecord(agent, match, request, exclusive);
  }

  private serveRecord(
    agent: RoutingAgentRecord,
    match: RouteMatch,
    request: RouteRequest,
    exclusive: boolean,
  ): RouteOutcome {
    if (agent.deleted) return { kind: 'notice', code: 'agent_deleted', agent: ref(agent), match };
    if (agent.status !== ADDRESSABLE_STATUS) {
      return { kind: 'notice', code: 'agent_disabled', agent: ref(agent), match };
    }
    if ((match === 'binding' && !agent.bindable) || (match === 'default' && !agent.defaultable)) {
      return { kind: 'notice', code: 'agent_not_available', agent: ref(agent), match };
    }
    if (!this.isAvailable(agent, request)) {
      return { kind: 'notice', code: 'agent_not_available', agent: ref(agent), match };
    }
    return { kind: 'agent', agentId: agent.id, slug: agent.slug, match, exclusive };
  }

  /** Availability (spec §5.3): the channel, then the sender. */
  isAvailable(agent: RoutingAgentRecord, request: Pick<RouteRequest, 'channelType' | 'principal'>): boolean {
    if (agent.availableChannels !== null && !agent.availableChannels.includes(request.channelType)) {
      return false;
    }
    if (agent.availableToEveryone) return true;
    const principal = request.principal;
    if (principal === undefined) return false;
    for (const allowed of agent.availablePrincipals) {
      if (allowed === principal) return true;
      if (allowed.startsWith('role:') && this.options.hasRole?.(principal, allowed.slice('role:'.length))) {
        return true;
      }
    }
    return false;
  }
}

/**
 * The default-agent entry for a sender in a channel: (user, channel), then
 * (user), then (channel), then the instance. The first that exists wins.
 */
export function defaultEntryFor(
  entries: readonly DefaultAgentEntryRow[],
  principal: string | undefined,
  channelType: string,
): DefaultAgentEntryRow | undefined {
  const find = (p: string | null, c: string | null): DefaultAgentEntryRow | undefined =>
    entries.find((e) => e.principal === p && e.channelType === c);
  if (principal !== undefined) {
    const exact = find(principal, channelType) ?? find(principal, null);
    if (exact) return exact;
  }
  return find(null, channelType) ?? find(null, null);
}
