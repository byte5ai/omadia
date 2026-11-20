/**
 * #2082 — routines are user-requested triggers (spec 2042 §5.12, "Changes to
 * today's mechanisms"). The routine runner keeps everything a routine has
 * (human owner, pause/resume/delete, run history, output templates, cron
 * semantics, the owner's identity for the turn); WHEN it fires is the
 * trigger engine's: durable, once per occurrence, with a deadline, a budget,
 * the kill switch and the circuit breaker.
 *
 * This is the runner's scheduler port backed by triggers. `register` arms the
 * routine in this process and makes sure its one trigger exists and is
 * active; `dispose` disarms it and brings the trigger in line with the row
 * (deleted → the trigger ends, paused → it pauses, still active → shutdown,
 * nothing changes). A firing runs the runner's own handler.
 *
 * New compared to the croner job: a deadline (`until`, moved by a renewal the
 * owner is asked for before it ends), a budget, and no catch-up storm after
 * downtime: a missed occurrence is fired once, late, from the durable table.
 */

import type { JobHandler, JobSpec } from '@omadia/plugin-api';
import { meterModelCalls, meterUsageCost } from '@omadia/usage-telemetry';

import type { JobSchedulerLike } from '../plugins/routines/routineRunner.js';
import type { Routine } from '../plugins/routines/routineStore.js';
import { createCron } from '../scheduler/cronerCompat.js';
import type { TurnOutcome } from './triggerChain.js';
import { cronMinGapSeconds, type TriggerLimits } from './triggerPolicy.js';
import type { TriggerService } from './triggerService.js';
import { routineLang, routineTexts } from './routineTexts.js';
import type { Trigger } from './types.js';

const DAY_MS = 86_400_000;
/** The owner is asked this long before the deadline whether to go on. */
export const RENEWAL_LEAD_MS = 3 * DAY_MS;

export interface RoutineRowAccess {
  get(id: string): Promise<Routine | null>;
  setUntil(id: string, until: Date | null): Promise<Routine | null>;
  markExpired(id: string, message: string): Promise<Routine | null>;
  listActiveEndingBefore(before: Date): Promise<Routine[]>;
  markRenewalAsked(id: string, at: Date): Promise<boolean>;
}

export interface RoutineTriggerDeps {
  readonly service: () => TriggerService | undefined;
  readonly routines: () => RoutineRowAccess | undefined;
  /** The agent a routine runs as; none for `null` (no fallback agent, #2055). */
  readonly resolveAgent: (slug: string | null) => { readonly id: string; readonly slug: string } | undefined;
  /** The renewal question goes out through the routine's own channel. */
  readonly askOwner: (routine: Routine, text: string) => Promise<void>;
  readonly limits: () => TriggerLimits;
  /** The instance's answer language (`ai_disclosure_locale`). */
  readonly language?: () => string | undefined;
  /** Time zone for dates in owner messages (the proactive default). */
  readonly timeZone?: string;
  readonly now?: () => Date;
  readonly log: (message: string) => void;
}

export interface RoutineTriggerScheduler extends JobSchedulerLike {
  /** The engine's `turn` for a routine trigger. */
  fire(trigger: Trigger): Promise<TurnOutcome>;
  /** Ask owners about routines ending soon; pause the ones past their deadline. */
  sweep(): Promise<void>;
  /** The harness paused a routine's trigger (budget, breaker): the row
   *  follows. `cause` is the trigger's pause reason. */
  pausedByHarness(routineId: string, cause: string): Promise<void>;
}

const ownerKey = (r: Routine): string => `${r.tenant}\n${r.userId}`;

/** How many times `cron` fires between now and `until` (at most `cap`). */
export function cronRunsUntil(cron: string, until: Date, from: Date, cap: number): number {
  const job = createCron(cron, {});
  let count = 0;
  let cursor: Date | null = from;
  while (count < cap) {
    cursor = job.nextRun(cursor ?? undefined);
    if (!cursor || cursor > until) break;
    count += 1;
  }
  return Math.max(count, 1);
}

export function renewalText(r: Routine, until: Date, language?: string, timeZone = 'UTC'): string {
  return routineTexts.renewal(routineLang(language), r.name, until, timeZone);
}

export function createRoutineTriggerScheduler(deps: RoutineTriggerDeps): RoutineTriggerScheduler {
  const clock = deps.now ?? (() => new Date());
  const lang = () => routineLang(deps.language?.());
  const armed = new Map<string, { handler: JobHandler; timeoutMs: number }>();

  async function triggerOf(routineId: string): Promise<Trigger | undefined> {
    return (await deps.service()?.listForContext('routine', routineId))?.[0];
  }

  /** Make the routine's trigger exist and match the row. */
  async function ensure(routineId: string): Promise<void> {
    const service = deps.service();
    const routines = deps.routines();
    if (!service || !routines) return;
    let routine = await routines.get(routineId);
    if (!routine || routine.status !== 'active') return;
    const now = clock();
    const limits = deps.limits();
    if (!routine.until) {
      routine = (await routines.setUntil(routine.id, new Date(now.getTime() + limits.recurringMaxDays * DAY_MS))) ?? routine;
    }
    const until = routine.until as Date;
    const existing = await triggerOf(routine.id);
    if (until.getTime() <= now.getTime()) {
      await expire(routine);
      return;
    }
    if (existing) {
      if (existing.until.getTime() !== until.getTime()) await service.renew(existing.id, until, `routine:${routine.id}`);
      // The row is active: its owner resumed it (a harness pause also pauses
      // the row, so a restart does not lift a breaker or budget pause).
      if (existing.state === 'paused') await service.resume(existing.id, `routine:${routine.id}`);
      return;
    }
    const agent = deps.resolveAgent(routine.agentSlug ?? null);
    if (!agent) {
      deps.log(`[routines/triggers] routine ${routine.id}: no agent '${routine.agentSlug ?? 'default'}' in service; not scheduled`);
      return;
    }
    const res = await service.create(
      'wake_every',
      {
        purpose: routine.name,
        cron: routine.cron,
        until: until.toISOString(),
        max_runs: cronRunsUntil(routine.cron, until, now, limits.maxRunsCap),
        actions: [{ type: 'turn', instruction: routine.prompt }],
        budget: {
          per_firing_usd: limits.perFiringUsdMax,
          total_usd: limits.perTriggerUsdMax,
          model_calls_per_firing: limits.modelCallsPerFiringMax,
        },
      },
      {
        agentId: agent.id,
        agentSlug: agent.slug,
        origin: 'routine',
        ownerKey: ownerKey(routine),
        contextKind: 'routine',
        contextId: routine.id,
        liveContext: false,
        deliveryChannel: routine.channel,
        deliveryRef: routine.conversationRef,
        labels: [],
        createdBy: `routine:${routine.id} owner ${routine.tenant}/${routine.userId}`,
      },
    ).catch((err: unknown) => {
      // Another machine scheduled it first (one trigger per routine).
      if ((err as { code?: string }).code === '23505') return undefined;
      throw err;
    });
    if (res && !res.ok) {
      deps.log(`[routines/triggers] routine ${routine.id} not scheduled: ${res.code}: ${res.message}`);
      // The owner sees why it does not run instead of an "active" row that never fires.
      await routines.markExpired(routine.id, routineTexts.notScheduled(lang(), res.message));
    }
  }

  async function expire(routine: Routine): Promise<void> {
    await deps.routines()?.markExpired(
      routine.id,
      routineTexts.expired(lang()),
    );
    const t = await triggerOf(routine.id);
    if (t) await deps.service()?.end(t.id, 'expired', { routine: routine.id });
  }

  /** The row changed (paused, deleted) or the process stops. */
  async function settle(routineId: string): Promise<void> {
    const service = deps.service();
    const routines = deps.routines();
    if (!service || !routines) return;
    const t = await triggerOf(routineId);
    if (!t) return;
    const routine = await routines.get(routineId);
    if (!routine) {
      await service.end(t.id, 'cancelled', { routine: routineId, why: 'deleted' });
    } else if (routine.status === 'paused' && t.state === 'active') {
      await service.pause(t.id, 'owner', `routine:${routineId}`);
    }
  }

  const report = (what: string) => (err: unknown): void => {
    deps.log(`[routines/triggers] ${what}: ${err instanceof Error ? err.message : String(err)}`);
  };

  return {
    register(_agentId: string, spec: JobSpec, handler: JobHandler): () => void {
      const routineId = spec.name;
      const cron = 'cron' in spec.schedule ? spec.schedule.cron : undefined;
      if (!cron) throw new Error('a routine runs on a cron pattern');
      // Synchronous, so the runner rolls a refused routine back.
      const gap = cronMinGapSeconds(cron, undefined, clock());
      const min = deps.limits().minIntervalSeconds;
      if (gap === undefined) throw new Error(`invalid cron pattern '${cron}'`);
      if (gap < min) {
        // An existing routine that ran more often stops here on upgrade: its
        // owner sees why on the row instead of a silent "active".
        void deps
          .routines()
          ?.markExpired(routineId, routineTexts.tooFrequent(lang(), min / 60))
          .catch(report(`marking ${routineId}`));
        throw new Error(`a routine runs at most every ${String(min / 60)} minutes`);
      }
      armed.set(routineId, { handler, timeoutMs: spec.timeoutMs ?? 600_000 });
      void ensure(routineId).catch(report(`scheduling ${routineId}`));
      return () => {
        armed.delete(routineId);
        void settle(routineId).catch(report(`settling ${routineId}`));
      };
    },

    stopForPlugin(): void {
      armed.clear();
    },

    async fire(trigger: Trigger): Promise<TurnOutcome> {
      const routineId = trigger.contextId;
      const entry = armed.get(routineId);
      const routines = deps.routines();
      if (!entry || !routines) {
        const row = await routines?.get(routineId);
        if (!row || row.status !== 'active') return { delivered: false, costUsd: 0, modelCalls: 0 };
        return { delivered: false, costUsd: 0, modelCalls: 0, error: 'the routine is not armed on this instance' };
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error('routine run timed out')), entry.timeoutMs);
      const started = clock();
      try {
        const metered = await meterUsageCost(() =>
          meterModelCalls(() => entry.handler(controller.signal), { limit: trigger.modelCallsPerFiring }),
        );
        const row = await routines.get(routineId);
        const ran = row?.lastRunAt && row.lastRunAt.getTime() >= started.getTime() - 1000;
        const base = { costUsd: metered.costUsd, modelCalls: metered.value.modelCalls };
        if (!row || !ran) return { delivered: false, ...base };
        return row.lastRunStatus === 'ok'
          ? { delivered: true, ...base }
          : { delivered: false, ...base, error: row.lastRunError ?? `routine run ${row.lastRunStatus ?? 'failed'}` };
      } finally {
        clearTimeout(timer);
      }
    },

    async pausedByHarness(routineId: string, why: string): Promise<void> {
      // `why` is the trigger's pause reason; the owner reads it localized.
      const routines = deps.routines();
      if (!routines) return;
      const row = await routines.markExpired(routineId, routineTexts.paused(lang(), why));
      if (row) armed.delete(routineId);
    },

    async sweep(): Promise<void> {
      const routines = deps.routines();
      if (!routines) return;
      // An armed routine whose trigger ended (max runs, a cancellation) gets
      // it back: the row is the truth while it is active.
      for (const routineId of [...armed.keys()]) {
        await ensure(routineId).catch(report(`re-arming ${routineId}`));
      }
      const now = clock();
      for (const r of await routines.listActiveEndingBefore(new Date(now.getTime() + RENEWAL_LEAD_MS))) {
        const until = r.until as Date;
        if (until.getTime() <= now.getTime()) {
          await expire(r).catch(report(`expiring ${r.id}`));
          continue;
        }
        if (r.renewalAskedAt) continue;
        if (await routines.markRenewalAsked(r.id, now)) {
          await deps.askOwner(r, renewalText(r, until, deps.language?.(), deps.timeZone)).catch(report(`asking the owner of ${r.id}`));
        }
      }
    },
  };
}
