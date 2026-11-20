/**
 * #2082 — the kernel's trigger service: creating triggers under the harness
 * rules, routing events to hooks, ending contexts, and the owner/operator
 * controls. The agent tools, the routines and the operator routes all go
 * through here; nothing else writes `agent_triggers`.
 */

import { evaluatePredicate } from '@omadia/conductor-core';
import type { JsonObject, Predicate } from '@omadia/conductor-core';

import { validateTriggerRequest, type TriggerEnvelope, type TriggerLimits } from './triggerPolicy.js';
import { eventOccurrenceKey, firstDue, nextDue } from './triggerSchedule.js';
import type { CreateResult, TriggerStore } from './triggerStore.js';
import type {
  DataActionSpec,
  Trigger,
  TriggerContextKind,
  TriggerEndReason,
  TriggerKind,
  TriggerRefusal,
  TriggerTarget,
} from './types.js';

/** One entry of the event-source catalogue an agent may hook into. */
export interface EventSource {
  readonly eventId: string;
  /** The plugin (or `kernel`) that emits it. */
  readonly source: string;
}

export interface TriggerServiceDeps {
  readonly store: TriggerStore;
  readonly limits: TriggerLimits;
  /** The events this agent's channels and capabilities offer. */
  readonly eventSources: (agentSlug: string) => readonly EventSource[];
  /** Why the agent may not run this data action (undefined = it may). */
  readonly checkDataAction: (agentSlug: string, action: DataActionSpec) => string | undefined;
  /** Whether a proactive message from this envelope may go to `target`. */
  readonly targetAllowed: (env: TriggerEnvelope, target: TriggerTarget) => boolean;
  readonly now?: () => Date;
  readonly log?: (message: string) => void;
}

export type CreateTriggerResult = { readonly ok: true; readonly trigger: Trigger } | TriggerRefusal;

const conversationPart = (contextId: string): string => {
  const i = contextId.indexOf(':');
  return i >= 0 ? contextId.slice(i + 1) : contextId;
};

/** A context id for a conversation: `<channel>:<conversation id>`. */
export const conversationContextId = (channel: string, conversationId: string): string => `${channel}:${conversationId}`;

export class TriggerService {
  constructor(private readonly deps: TriggerServiceDeps) {}

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }

  get limits(): TriggerLimits {
    return this.deps.limits;
  }

  eventSourcesFor(agentSlug: string): readonly EventSource[] {
    return this.deps.eventSources(agentSlug);
  }

  async create(kind: TriggerKind, raw: unknown, env: TriggerEnvelope): Promise<CreateTriggerResult> {
    const now = this.now();
    const valid = validateTriggerRequest(kind, raw, env, this.deps.limits, now);
    if (!valid.ok) return valid;
    const t = valid.value;

    if (t.eventId !== null) {
      const known = this.deps.eventSources(env.agentSlug).some((s) => s.eventId === t.eventId);
      if (!known) {
        const offered = this.deps.eventSources(env.agentSlug).map((s) => s.eventId);
        return {
          ok: false,
          code: 'unknown_event',
          message: `event '${t.eventId}' is not offered to this agent; available: ${offered.length > 0 ? offered.join(', ') : 'none'}`,
        };
      }
    }
    for (const step of t.actions) {
      const action = step.type === 'deliver' || (step.type === 'check' && step.check === 'data') ? step.action : undefined;
      if (!action) continue;
      const why = this.deps.checkDataAction(env.agentSlug, action);
      if (why) return { ok: false, code: 'unknown_tool', message: why };
    }
    if (t.target && !this.deps.targetAllowed(env, t.target)) {
      return {
        ok: false,
        code: 'target_not_allowed',
        message: 'a proactive message from this conversation may not go to that target',
      };
    }

    const due = firstDue(t, now);
    if (t.kind !== 'on_event' && !due) {
      return { ok: false, code: 'invalid', message: 'the trigger would never fire before its deadline' };
    }
    const created: CreateResult = await this.deps.store.create(t, due, this.deps.limits.maxActivePerAgent);
    if (!created.ok) return { ok: false, code: created.code, message: created.message };
    this.deps.log?.(
      `[triggers] created ${created.trigger.kind} ${created.trigger.id} for '${created.trigger.agentSlug}' (${created.trigger.purpose})`,
    );
    return created;
  }

  /**
   * An event arrived on the bus. Marks activity in its conversation context
   * and enqueues one occurrence per matching hook (once per event).
   */
  async onEvent(eventId: string, payload: Readonly<Record<string, unknown>>, eventKey: string): Promise<number> {
    const now = this.now();
    const conversationId = typeof payload['conversationId'] === 'string' ? payload['conversationId'] : undefined;
    const channel =
      typeof payload['channelType'] === 'string'
        ? payload['channelType']
        : typeof payload['channel'] === 'string'
          ? payload['channel']
          : undefined;
    if (conversationId && channel) {
      await this.deps.store.noteActivity('conversation', conversationContextId(channel, conversationId), now);
      await this.deps.store.noteActivity('meeting', conversationContextId(channel, conversationId), now);
    }
    const hooks = await this.deps.store.listHooks(eventId);
    let enqueued = 0;
    for (const hook of hooks) {
      if (!this.hookMatches(hook, payload, conversationId)) continue;
      const added = await this.deps.store.enqueueEvent(hook.id, eventOccurrenceKey(eventId, eventKey), now, { ...payload });
      if (added) enqueued += 1;
    }
    return enqueued;
  }

  private hookMatches(hook: Trigger, payload: Readonly<Record<string, unknown>>, conversationId: string | undefined): boolean {
    // A hook bound to a conversation or meeting hears only that one.
    if ((hook.contextKind === 'conversation' || hook.contextKind === 'meeting') && conversationId !== undefined) {
      if (conversationPart(hook.contextId) !== conversationId) return false;
    }
    if (!hook.eventFilter) return true;
    try {
      const ctx = payload as JsonObject;
      return evaluatePredicate(hook.eventFilter as Predicate, { ctx, stepResult: ctx });
    } catch {
      return false;
    }
  }

  /** A context ended: all its triggers end in one transaction. */
  async endContext(kind: TriggerContextKind, contextId: string): Promise<readonly Trigger[]> {
    const ended = await this.deps.store.endContext(kind, contextId, this.now());
    if (ended.length > 0) {
      this.deps.log?.(`[triggers] context ${kind}:${contextId} ended → ${String(ended.length)} trigger(s) ended`);
    }
    return ended;
  }

  async end(id: string, reason: TriggerEndReason, detail: Record<string, unknown> = {}): Promise<boolean> {
    return this.deps.store.end(id, reason, detail);
  }

  async pause(id: string, reason: 'owner' | 'operator', by: string): Promise<Trigger | undefined> {
    return this.deps.store.pause(id, reason, { by });
  }

  async resume(id: string, by: string): Promise<Trigger | undefined> {
    const t = await this.deps.store.get(id);
    if (!t) return undefined;
    const now = this.now();
    const due = t.kind === 'wake_at' ? (t.fireAt && t.fireAt > now ? t.fireAt : now) : t.kind === 'wake_every' ? nextDue(t, now, now) : undefined;
    return this.deps.store.resume(id, due, by);
  }

  /** Move the deadline, within the caps measured from now. */
  async renew(id: string, until: Date, by: string): Promise<CreateTriggerResult> {
    const t = await this.deps.store.get(id);
    if (!t) return { ok: false, code: 'invalid', message: 'no such trigger' };
    const now = this.now();
    const capDays = t.kind === 'wake_at' ? this.deps.limits.oneShotMaxDays : this.deps.limits.recurringMaxDays;
    if (until.getTime() <= now.getTime()) return { ok: false, code: 'invalid', message: 'until must lie in the future' };
    if (until.getTime() - now.getTime() > capDays * 86_400_000) {
      return { ok: false, code: 'deadline_too_far', message: `until may lie at most ${String(capDays)} days ahead` };
    }
    const renewed = await this.deps.store.renew(id, until, by);
    return renewed ? { ok: true, trigger: renewed } : { ok: false, code: 'invalid', message: 'the trigger could not be renewed' };
  }

  get(id: string): Promise<Trigger | undefined> {
    return this.deps.store.get(id);
  }

  listForAgent(agentId: string): Promise<Trigger[]> {
    return this.deps.store.listByAgent(agentId);
  }

  listForOwner(ownerKey: string): Promise<Trigger[]> {
    return this.deps.store.listByOwner(ownerKey);
  }

  listForContext(kind: TriggerContextKind, contextId: string): Promise<Trigger[]> {
    return this.deps.store.listByContext(kind, contextId);
  }

  listAll(limit: number): Promise<Trigger[]> {
    return this.deps.store.listAll(limit);
  }
}
