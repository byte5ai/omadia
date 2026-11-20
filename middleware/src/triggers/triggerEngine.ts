/**
 * #2082 — one firing of one occurrence, with every harness guarantee of
 * spec 2042 §5.12 in front of it. Deterministic; the only model call is the
 * chain's `turn`, and it runs only after every guard passed.
 *
 * Order (cheapest and most final first):
 *   1. the trigger still exists, is active and before its deadline
 *   2. the agent is in service (INV-7: otherwise the operator hears of it)
 *   3. no kill switch (instance or agent)
 *   4. the recipient's quiet hours and rate limit (defer, never spend)
 *   5. budget reservation, only when the chain can reach a model
 *   6. the chain
 *   7. settle: counters, spend, breaker, next occurrence, end
 */

import { chainUsesModel, type TriggerLimits } from './triggerPolicy.js';
import { runChain, type StepExecutors } from './triggerChain.js';
import { nextDue } from './triggerSchedule.js';
import { spendMonth, type ClaimedOccurrence, type FinishInput, type TriggerStore } from './triggerStore.js';
import type { Trigger, TriggerPauseReason } from './types.js';

export interface TriggerAgentView {
  readonly id: string;
  readonly slug: string;
  readonly enabled: boolean;
  /** The agent's display name (its authored identity name, else the slug). */
  readonly displayName?: string;
}

/** Before anything runs: may a proactive message go out now? */
export type SendWindow =
  | { readonly ok: true }
  | { readonly ok: false; readonly deferUntil: Date; readonly reason: string }
  | { readonly ok: false; readonly drop: string };

export interface OperatorNotice {
  readonly agentSlug: string;
  readonly triggerId: string;
  readonly origin: Trigger['origin'];
  readonly contextKind: Trigger['contextKind'];
  readonly contextId: string;
  readonly purpose: string;
  readonly reason: TriggerPauseReason | 'agent_unavailable' | 'kill_switch';
  readonly message: string;
}

export interface TriggerEngineDeps {
  readonly store: TriggerStore;
  readonly limits: TriggerLimits;
  readonly executors: StepExecutors;
  readonly resolveAgent: (slug: string) => TriggerAgentView | undefined;
  readonly sendWindow: (trigger: Trigger, now: Date) => Promise<SendWindow>;
  /** A `system` notice to the operator (budget, breaker, unavailable agent). */
  readonly notifyOperator: (notice: OperatorNotice) => void;
  readonly now?: () => Date;
  readonly log?: (message: string) => void;
}

export type FireOutcome =
  | 'acted'
  | 'nothing'
  | 'failed'
  | 'refused'
  | 'deferred'
  | 'dropped'
  | 'ended'
  | 'lease_lost';

export class TriggerEngine {
  constructor(private readonly deps: TriggerEngineDeps) {}

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }

  private log(message: string): void {
    this.deps.log?.(message);
  }

  async fire(occ: ClaimedOccurrence): Promise<FireOutcome> {
    const { store } = this.deps;
    const now = this.now();
    const trigger = await store.get(occ.triggerId);
    if (!trigger) {
      await store.drop(occ.id, occ.leaseOwner, 'trigger_gone');
      return 'dropped';
    }
    if (trigger.until.getTime() < now.getTime()) {
      await store.drop(occ.id, occ.leaseOwner, 'expired');
      await store.end(trigger.id, 'expired');
      return 'ended';
    }
    if (trigger.state !== 'active') {
      await store.drop(occ.id, occ.leaseOwner, 'paused');
      return 'dropped';
    }

    const base = {
      occurrenceId: occ.id,
      leaseOwner: occ.leaseOwner,
      triggerId: trigger.id,
      agentId: trigger.agentId,
      month: spendMonth(now),
      breaker: { failures: this.deps.limits.breakerFailures, ineffective: this.deps.limits.breakerIneffective },
      ineffectiveTurn: false,
      effectiveTurn: false,
      costUsd: 0,
    } as const;
    const next = nextDue(trigger, occ.dueAt, now);

    const agent = this.deps.resolveAgent(trigger.agentSlug);
    if (!agent || !agent.enabled) {
      // Fail loud (INV-7): never a substitute. It counts as a failure, so the
      // breaker pauses a trigger whose agent stays away.
      const reason = agent ? 'disabled' : 'not in service';
      this.deps.notifyOperator({
        agentSlug: trigger.agentSlug,
        triggerId: trigger.id,
        origin: trigger.origin,
        contextKind: trigger.contextKind,
        contextId: trigger.contextId,
        purpose: trigger.purpose,
        reason: 'agent_unavailable',
        message: `Agent '${trigger.agentSlug}' is ${reason}; its trigger "${trigger.purpose}" did not fire.`,
      });
      return this.settle(trigger, {
        ...base,
        outcome: 'failed',
        countsAsRun: false,
        error: `agent ${reason}`,
        ...(next ? { nextDueAt: next } : {}),
        detail: { refusal: 'agent_unavailable' },
      });
    }

    if (await store.killSwitchSet(trigger.agentId)) {
      return this.settle(trigger, {
        ...base,
        outcome: 'refused',
        countsAsRun: false,
        ...(next ? { nextDueAt: next } : {}),
        detail: { refusal: 'kill_switch' },
      });
    }

    const window = await this.deps.sendWindow(trigger, now);
    if (!window.ok) {
      if ('deferUntil' in window && window.deferUntil.getTime() <= trigger.until.getTime()) {
        await store.defer(occ.id, occ.leaseOwner, window.deferUntil, trigger, window.reason);
        return 'deferred';
      }
      const reason = 'drop' in window ? window.drop : window.reason;
      return this.settle(trigger, {
        ...base,
        outcome: 'refused',
        countsAsRun: false,
        ...(next ? { nextDueAt: next } : {}),
        detail: { refusal: reason },
      });
    }

    if (chainUsesModel(trigger.actions) && trigger.budgetPerFiringUsd > 0) {
      const reserved = await store.reserve(
        trigger,
        trigger.budgetPerFiringUsd,
        base.month,
        {
          monthlyAgentUsd: this.deps.limits.monthlyAgentUsd,
          monthlyInstanceUsd: this.deps.limits.monthlyInstanceUsd,
        },
        occ.id,
      );
      if (!reserved.ok) {
        await store.drop(occ.id, occ.leaseOwner, `budget_${reserved.scope}`);
        await this.pauseWithNotice(trigger, 'budget', `the ${reserved.scope} budget would be exceeded`);
        return 'refused';
      }
    }

    const chain = await runChain(trigger, occ, this.deps.executors, now);
    if (chain.error) this.log(`[triggers] ${trigger.id} (${trigger.agentSlug}) failed: ${chain.error}`);
    return this.settle(trigger, {
      ...base,
      outcome: chain.outcome,
      countsAsRun: true,
      ineffectiveTurn: chain.turnRan && !chain.turnEffective && chain.outcome !== 'failed',
      effectiveTurn: chain.turnEffective,
      costUsd: chain.costUsd,
      ...(chain.error ? { error: chain.error } : {}),
      ...(chain.fingerprint ? { fingerprint: chain.fingerprint } : {}),
      ...(chain.contextEnded ? { end: 'context_ended' as const } : {}),
      ...(next && !chain.contextEnded ? { nextDueAt: next } : {}),
      detail: { steps: chain.steps, modelCalls: chain.modelCalls },
    });
  }

  private async settle(trigger: Trigger, input: FinishInput): Promise<FireOutcome> {
    const res = await this.deps.store.finish(input);
    if (res.leaseLost) {
      this.log(`[triggers] ${trigger.id} (${trigger.agentSlug}): lease lost while firing; spend booked, nothing else settled`);
      return 'lease_lost';
    }
    if (res.paused) {
      this.notifyPaused(trigger, res.paused);
    }
    if (res.ended) return input.outcome === 'refused' ? 'refused' : (input.outcome as FireOutcome);
    return input.outcome as FireOutcome;
  }

  private async pauseWithNotice(trigger: Trigger, reason: TriggerPauseReason, why: string): Promise<void> {
    await this.deps.store.pause(trigger.id, reason, { why });
    this.notifyPaused(trigger, reason, why);
  }

  private notifyPaused(trigger: Trigger, reason: TriggerPauseReason, why?: string): void {
    const text: Record<TriggerPauseReason, string> = {
      breaker_failures: 'it failed several times in a row',
      breaker_ineffective: 'its model turns had no effect several times in a row',
      budget: why ?? 'a budget cap was reached',
      owner: 'its owner paused it',
      operator: 'an operator paused it',
    };
    this.deps.notifyOperator({
      agentSlug: trigger.agentSlug,
      triggerId: trigger.id,
      origin: trigger.origin,
      contextKind: trigger.contextKind,
      contextId: trigger.contextId,
      purpose: trigger.purpose,
      reason,
      message: `Trigger "${trigger.purpose}" of agent '${trigger.agentSlug}' was paused: ${text[reason]}.`,
    });
  }
}
