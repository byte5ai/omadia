/**
 * #2090 — the plugin-facing execution authorization, one facade per calling
 * plugin. The store keeps the durable facts; this file is the rules that need
 * to know WHO asks: only the plugin that delivers the agent's archetype is
 * answered, and only about its own processes and scopes.
 */

import {
  EXECUTION_SCOPE_KINDS,
  EXECUTION_SCOPE_PHASES,
  type AuthorizeActionRequest,
  type ConversationReservation,
  type ExecutionAuthorization,
  type ExecutionAuthorizationService,
  type ExecutionRefusal,
  type ExecutionRefusalCode,
  type ExecutionScope,
  type ExecutionScopeKind,
  type ExecutionTarget,
  type OpenExecutionScopeRequest,
} from '@omadia/plugin-api';

import type { ExecutionScopeStore, ReservationRow, ScopeRow } from './scopeStore.js';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** `closing`: absolute limit after its event (spec 2043 §0). */
export const CLOSING_ABSOLUTE_LIMIT_MS = 30 * DAY_MS;
/** No scope lives longer than this after it was opened. */
export const SCOPE_MAX_LIFETIME_MS = 365 * DAY_MS;
/** The deadline wait of an `active` scope moves its deadline at most this far
 *  from now: the wait is bounded by session closings, which are. */
export const DEADLINE_WAIT_MAX_MS = 30 * DAY_MS;
const MAX_BUDGET = 1_000_000;
const MAX_TARGETS = 2_000;
const MAX_ID_LENGTH = 200;

const DEADLINE_WAIT_PURPOSES: ReadonlySet<string> = new Set(['consent', 'status', 'stop']);
const ACTIONS_WITH_TARGET: ReadonlySet<string> = new Set(['post', 'direct_message', 'card_update', 'delivery']);
const PURPOSES: ReadonlySet<string> = new Set([
  'moderation', 'handshake', 'link', 'reminder', 'status', 'consent', 'stop',
  'essential_message', 'protocol_dispatch', 'invitation', 'readiness_check', 'roster_check', 'other',
]);
const ACTIONS: ReadonlySet<string> = new Set(['model_turn', 'post', 'direct_message', 'card_update', 'check', 'delivery']);

export interface ExecutionAgent {
  readonly id: string;
  readonly slug: string;
  readonly archetype: string;
  readonly enabled: boolean;
}

export interface ExecutionAuthorizationDeps {
  readonly store: ExecutionScopeStore;
  /** The kernel-known id of the calling plugin. */
  readonly callerPluginId: string;
  /** A live (not deleted) agent by slug. */
  readonly resolveAgent: (slug: string) => ExecutionAgent | undefined;
  /** The plugin that delivers an archetype, if exactly one does. */
  readonly archetypePluginIdFor: (archetypeId: string) => string | undefined;
  /** `configuring`: how long it may last at most. */
  readonly configuringMaxMs: number;
  /**
   * #2089 — called after a reservation was released or a scope ended: what a
   * process may read follows from both, and the message subscriptions are
   * adjusted at once instead of at the next periodic check.
   */
  readonly onAccessChanged?: () => void;
  readonly now?: () => Date;
  readonly log?: (message: string) => void;
}

const refuse = (code: ExecutionRefusalCode, message: string): ExecutionRefusal => ({
  outcome: 'refused',
  code,
  message,
});

const publicScope = (row: ScopeRow): ExecutionScope => {
  const { agentId: _agentId, pluginId: _pluginId, ...scope } = row;
  return scope;
};

const publicReservation = (row: ReservationRow): ConversationReservation => ({
  channelType: row.channelType,
  conversationId: row.conversationId,
  processId: row.processId,
  role: row.role,
  reservedAt: row.reservedAt,
  ...(row.releasedAt ? { releasedAt: row.releasedAt } : {}),
});

const isId = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= MAX_ID_LENGTH;

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_BUDGET;

/** A well-formed target, or undefined. Unknown fields are dropped. */
export function readTarget(raw: unknown): ExecutionTarget | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const t = raw as Record<string, unknown>;
  if (!isId(t['channelType'])) return undefined;
  if (t['kind'] === 'conversation' && isId(t['conversationId'])) {
    return { kind: 'conversation', channelType: t['channelType'], conversationId: t['conversationId'] };
  }
  if (t['kind'] === 'person' && isId(t['principalId'])) {
    return {
      kind: 'person',
      channelType: t['channelType'],
      principalId: t['principalId'],
      ...(t['restriction'] === 'status_only' ? { restriction: 'status_only' as const } : {}),
    };
  }
  return undefined;
}

/** The scope's entry for a target: same conversation, or same person. */
export function matchingTarget(
  targets: readonly ExecutionTarget[],
  wanted: ExecutionTarget,
): ExecutionTarget | undefined {
  return targets.find((t) => {
    if (t.kind !== wanted.kind || t.channelType !== wanted.channelType) return false;
    return t.kind === 'conversation'
      ? t.conversationId === (wanted as typeof t).conversationId
      : t.principalId.toLowerCase() === (wanted as typeof t).principalId.toLowerCase();
  });
}

export function createExecutionAuthorizationService(
  deps: ExecutionAuthorizationDeps,
): ExecutionAuthorizationService {
  const { store, callerPluginId } = deps;
  const now = deps.now ?? (() => new Date());

  /** The agent, if the caller delivers its archetype and it is in service. */
  const permittedAgent = (slug: unknown): ExecutionAgent | ExecutionRefusal => {
    if (!isId(slug)) return refuse('invalid_request', 'agentSlug is required');
    const agent = deps.resolveAgent(slug);
    if (!agent) return refuse('unknown_agent', `no agent '${slug}'`);
    if (deps.archetypePluginIdFor(agent.archetype) !== callerPluginId) {
      return refuse('not_permitted', `agent '${slug}' is not of an archetype this plugin delivers`);
    }
    if (!agent.enabled) return refuse('not_permitted', `agent '${slug}' is disabled`);
    return agent;
  };

  const ownScope = async (scopeId: unknown): Promise<ScopeRow | ExecutionRefusal> => {
    if (!isId(scopeId)) return refuse('invalid_request', 'scopeId is required');
    let row: ScopeRow | undefined;
    try {
      row = await store.getScope(scopeId);
    } catch {
      // A malformed uuid is an unknown scope, not a server error.
      row = undefined;
    }
    // A scope of another plugin is reported like one that does not exist.
    if (!row || row.pluginId !== callerPluginId) return refuse('unknown_scope', 'no such scope');
    return row;
  };

  const limitsFor = (
    kind: ExecutionScopeKind,
    requested: string | undefined,
  ): { deadline: Date; absoluteLimit: Date } | ExecutionRefusal => {
    const at = now().getTime();
    const absoluteLimit = new Date(
      at +
        (kind === 'configuring'
          ? deps.configuringMaxMs
          : kind === 'closing'
            ? CLOSING_ABSOLUTE_LIMIT_MS
            : SCOPE_MAX_LIFETIME_MS),
    );
    if (requested === undefined) {
      if (kind !== 'configuring') return refuse('invalid_request', `a '${kind}' scope needs a deadline`);
      return { deadline: absoluteLimit, absoluteLimit };
    }
    const deadline = new Date(requested);
    if (Number.isNaN(deadline.getTime())) return refuse('invalid_request', 'deadline is not a time');
    if (deadline.getTime() <= at) return refuse('deadline_passed', 'the deadline is not in the future');
    if (deadline.getTime() > absoluteLimit.getTime()) {
      return refuse(
        'limit_exceeded',
        `a '${kind}' scope ends at the latest ${absoluteLimit.toISOString()}`,
      );
    }
    return { deadline, absoluteLimit };
  };

  return {
    async openScope(request: OpenExecutionScopeRequest) {
      const agent = permittedAgent(request?.agentSlug);
      if ('outcome' in agent) return agent;
      if (!isId(request.processId)) return refuse('invalid_request', 'processId is required');
      if (!EXECUTION_SCOPE_KINDS.includes(request.kind)) return refuse('invalid_request', 'unknown scope kind');
      const perEvent = request.kind === 'closing' || request.kind === 'scheduling';
      if (perEvent && !isId(request.eventId)) {
        return refuse('invalid_request', `a '${request.kind}' scope needs an eventId`);
      }
      if (!isCount(request.budget?.actions) || !isCount(request.budget?.modelCalls)) {
        return refuse('invalid_request', 'budget.actions and budget.modelCalls are whole numbers from 0');
      }
      const raw = request.targets ?? [];
      if (!Array.isArray(raw) || raw.length > MAX_TARGETS) return refuse('invalid_request', 'too many targets');
      const targets: ExecutionTarget[] = [];
      for (const entry of raw) {
        const target = readTarget(entry);
        if (!target) return refuse('invalid_request', 'a target is malformed');
        if (!matchingTarget(targets, target)) targets.push(target);
      }
      let home: { channelType: string; conversationId: string } | undefined;
      if (request.kind === 'configuring') {
        const read = readTarget({ kind: 'conversation', ...request.home });
        if (!read || read.kind !== 'conversation') {
          return refuse('invalid_request', "a 'configuring' scope needs the home conversation");
        }
        home = { channelType: read.channelType, conversationId: read.conversationId };
        if (!matchingTarget(targets, read)) targets.unshift(read);
      }
      const limits = limitsFor(request.kind, request.deadline);
      if ('outcome' in limits) return limits;

      const opened = await store.openScope({
        agentId: agent.id,
        agentSlug: agent.slug,
        pluginId: callerPluginId,
        processId: request.processId,
        kind: request.kind,
        eventId: perEvent ? (request.eventId as string) : '',
        deadline: limits.deadline,
        absoluteLimit: limits.absoluteLimit,
        budgetActions: request.budget.actions,
        budgetModelCalls: request.budget.modelCalls,
        targets,
        ...(home ? { home } : {}),
      });
      if (!opened.ok) return refuse(opened.code, opened.message);
      deps.log?.(
        `[execution] scope opened: ${opened.scope.kind}${opened.scope.eventId ? `/${opened.scope.eventId}` : ''} for '${agent.slug}' process ${request.processId}, until ${opened.scope.deadline}`,
      );
      return { outcome: 'opened', scope: publicScope(opened.scope) };
    },

    async authorize(request: AuthorizeActionRequest): Promise<ExecutionAuthorization | ExecutionRefusal> {
      const scope = await ownScope(request?.scopeId);
      if ('outcome' in scope) return scope;
      if (!ACTIONS.has(request.action) || !PURPOSES.has(request.purpose)) {
        return refuse('invalid_request', 'unknown action or purpose');
      }
      const emission = request.emission;
      if (emission !== undefined && emission !== 'prose' && emission !== 'template' && emission !== 'data') {
        return refuse('invalid_request', "emission is 'prose', 'template' or 'data'");
      }
      if (request.action === 'model_turn' && emission !== undefined && emission !== 'prose') {
        return refuse('invalid_request', 'a model_turn produces prose');
      }
      const modelCalls = request.modelCalls ?? 0;
      if (!isCount(modelCalls)) return refuse('invalid_request', 'modelCalls is a whole number from 0');
      if (request.action === 'model_turn' ? modelCalls < 1 : modelCalls !== 0) {
        return refuse('invalid_request', 'a model_turn reserves at least one model call; no other action reserves any');
      }
      if (!EXECUTION_SCOPE_PHASES[scope.kind].includes(request.phase)) {
        return refuse('phase_mismatch', `phase '${String(request.phase)}' does not fit a '${scope.kind}' scope`);
      }
      // The agent must still be in service: a disable ends its scopes, and
      // this closes the moment between the two.
      const agent = permittedAgent(scope.agentSlug);
      if ('outcome' in agent) return agent;
      if (scope.deadlineWait && !DEADLINE_WAIT_PURPOSES.has(request.purpose)) {
        return refuse(
          'purpose_not_allowed',
          'past its deadline this scope only allows consent answers, status and stop',
        );
      }
      let target: ExecutionTarget | undefined;
      if (request.target !== undefined) {
        target = readTarget(request.target);
        if (!target) return refuse('invalid_request', 'the target is malformed');
        const listed = matchingTarget(scope.targets, target);
        if (!listed) return refuse('target_not_allowed', 'this scope does not list that target');
        if (listed.kind === 'person' && listed.restriction === 'status_only' && request.purpose !== 'status') {
          return refuse('target_not_allowed', 'this person may only receive the status');
        }
        if (request.action === 'post' && target.kind !== 'conversation') {
          return refuse('invalid_request', 'a post goes to a conversation');
        }
        if (request.action === 'direct_message' && target.kind !== 'person') {
          return refuse('invalid_request', 'a direct message goes to a person');
        }
      } else if (ACTIONS_WITH_TARGET.has(request.action)) {
        return refuse('invalid_request', `a ${request.action} needs a target`);
      }

      const taken = await store.authorize({
        scopeId: scope.id,
        pluginId: callerPluginId,
        action: request.action,
        purpose: request.purpose,
        phase: request.phase,
        modelCalls,
        ...(target ? { target } : {}),
        ...(emission ? { emission } : request.action === 'model_turn' ? { emission: 'prose' as const } : {}),
      });
      if (taken.ok) {
        return {
          outcome: 'authorized',
          authorizationId: taken.authorizationId,
          scopeId: scope.id,
          remaining: {
            actions: taken.scope.budget.actions - taken.scope.used.actions,
            modelCalls: taken.scope.budget.modelCalls - taken.scope.used.modelCalls,
          },
        };
      }
      // Nothing was taken. Say why, from the state as it is now.
      const current = await store.getScope(scope.id);
      if (!current || current.state !== 'open') return refuse('scope_ended', 'this scope has ended');
      if (new Date(current.deadline).getTime() <= now().getTime()) {
        return refuse('deadline_passed', `this scope's deadline passed at ${current.deadline}`);
      }
      const killed = await store.killSwitchFor(current);
      if (killed) return refuse('kill_switch', `stopped by an operator (${killed.level} kill switch)`);
      return refuse('budget_exhausted', "this scope's budget is used up");
    },

    async settle(authorizationId, used) {
      if (!isId(authorizationId) || !isCount(used?.modelCalls)) return;
      try {
        await store.settle(authorizationId, callerPluginId, used.modelCalls);
      } catch (err) {
        deps.log?.(`[execution] settle failed for ${authorizationId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    },

    async setPeople(scopeId, people) {
      const scope = await ownScope(scopeId);
      if ('outcome' in scope) return scope;
      if (scope.state !== 'open') return refuse('scope_ended', 'this scope has ended');
      if (!Array.isArray(people) || people.length > MAX_TARGETS) return refuse('invalid_request', 'too many people');
      const next: ExecutionTarget[] = scope.targets.filter((t) => t.kind === 'conversation');
      for (const entry of people) {
        const person = readTarget(entry);
        if (!person || person.kind !== 'person') return refuse('invalid_request', 'a person target is malformed');
        if (!matchingTarget(next, person)) next.push(person);
      }
      const updated = await store.setTargets(scope.id, callerPluginId, next);
      return updated ? { outcome: 'updated', scope: publicScope(updated) } : refuse('scope_ended', 'this scope has ended');
    },

    async extendScope(scopeId, change) {
      const scope = await ownScope(scopeId);
      if ('outcome' in scope) return scope;
      if (scope.state !== 'open') return refuse('scope_ended', 'this scope has ended');
      const deadline = new Date(change?.deadline);
      const at = now().getTime();
      if (Number.isNaN(deadline.getTime()) || deadline.getTime() <= at) {
        return refuse('invalid_request', 'the new deadline is not a time in the future');
      }
      const passed = new Date(scope.deadline).getTime() <= at;
      const wait = change.deadlineWait === true;
      if (wait && scope.kind !== 'active') {
        return refuse('invalid_request', "only an 'active' scope has a deadline wait");
      }
      // An expired scope never re-opens; the one exception is the bounded
      // deadline wait of an `active` scope (spec 2043 §5.6).
      if ((passed || scope.deadlineWait) && !wait) {
        return refuse('deadline_passed', 'the deadline has passed; only a deadline wait can extend this scope');
      }
      if (wait && deadline.getTime() > at + DEADLINE_WAIT_MAX_MS) {
        return refuse('limit_exceeded', 'a deadline wait is bounded to 30 days');
      }
      if (deadline.getTime() > new Date(scope.absoluteLimit).getTime()) {
        return refuse('limit_exceeded', `this scope ends at the latest ${scope.absoluteLimit}`);
      }
      const updated = await store.extend(scope.id, callerPluginId, deadline, wait);
      if (!updated) return refuse('scope_ended', 'this scope has ended');
      deps.log?.(
        `[execution] scope ${scope.kind} of process ${scope.processId}: deadline ${scope.deadline} -> ${updated.deadline}${wait ? ' (deadline wait)' : ''}`,
      );
      return { outcome: 'extended', scope: publicScope(updated) };
    },

    async endScope(scopeId, reason) {
      const scope = await ownScope(scopeId);
      if ('outcome' in scope) return;
      await store.endScope(scope.id, callerPluginId, typeof reason === 'string' && reason ? reason : 'ended');
      deps.onAccessChanged?.();
    },

    async listScopes(processId) {
      if (!isId(processId)) return [];
      return (await store.listScopesOfProcess(callerPluginId, processId)).map(publicScope);
    },

    async reserveConversation(request) {
      const agent = permittedAgent(request?.agentSlug);
      if ('outcome' in agent) return agent;
      const target = readTarget({ kind: 'conversation', ...request });
      if (!isId(request.processId) || !target || target.kind !== 'conversation') {
        return refuse('invalid_request', 'processId, channelType and conversationId are required');
      }
      // Only a process that exists (has an open scope of this agent) links a
      // further conversation.
      const scopes = await store.listScopesOfProcess(callerPluginId, request.processId);
      if (!scopes.some((s) => s.state === 'open' && s.agentId === agent.id)) {
        return refuse('scope_order', 'this process has no open scope');
      }
      const reserved = await store.reserve({
        channelType: target.channelType,
        conversationId: target.conversationId,
        holderKind: 'archetype_process',
        agentId: agent.id,
        pluginId: callerPluginId,
        processId: request.processId,
        role: 'session',
      });
      if (reserved.ok) return { outcome: 'reserved', reservation: publicReservation(reserved.reservation) };
      const holder = reserved.heldBy;
      if (holder && holder.pluginId === callerPluginId && holder.processId === request.processId) {
        return { outcome: 'reserved', reservation: publicReservation(holder) };
      }
      return refuse(
        'conversation_busy',
        holder?.holderKind === 'agent_discussion'
          ? 'an agent discussion holds this conversation'
          : 'another process holds this conversation',
      );
    },

    async releaseConversation(request) {
      const target = readTarget({ kind: 'conversation', ...request });
      if (!isId(request?.processId) || !target || target.kind !== 'conversation') return;
      await store.release({
        channelType: target.channelType,
        conversationId: target.conversationId,
        holderKind: 'archetype_process',
        pluginId: callerPluginId,
        processId: request.processId,
        reason: typeof request.reason === 'string' && request.reason ? request.reason : 'released',
      });
      deps.onAccessChanged?.();
    },

    async listReservations(processId) {
      if (!isId(processId)) return [];
      return (await store.listReservationsOfProcess(callerPluginId, processId)).map(publicReservation);
    },
  };
}
