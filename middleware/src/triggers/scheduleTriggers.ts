/**
 * #2082 — Agent Builder schedules (`agent_schedules`, P6) fire through
 * bounded triggers (spec 2042 §5.12, ADR-0020: nothing an agent does unasked
 * runs without a deadline, a budget and a breaker).
 *
 * Before, a minute poller ran a full model turn on every cron match, forever,
 * with no budget. Now each enabled schedule has exactly one trigger
 * (`context_kind 'schedule'`, origin `system`): a `wake_every` on the
 * schedule's cron and time zone with one `turn` step, the instance budget
 * caps, and a deadline (`agent_schedules.until`, at most the recurring cap
 * ahead). A schedule turn has no conversation: its effect is what the agent
 * does with its tools; the answer is recorded, not sent.
 *
 * When the deadline passes, the schedule is disabled and an operator notice
 * is recorded; an operator renews it (`renew`). Deleting or disabling the
 * schedule ends its trigger. `sync` brings triggers in line with the rows
 * (at boot, after a Builder change, and on the hourly sweep).
 */

import type { ScheduleRow } from '@omadia/orchestrator';

import { cronRunsUntil } from './routineTriggers.js';
import { cronMinGapSeconds, type TriggerLimits } from './triggerPolicy.js';
import type { TriggerService } from './triggerService.js';
import type { Trigger } from './types.js';

const DAY_MS = 86_400_000;
const DEFAULT_PROMPT = 'Scheduled run: perform your configured routine.';

/** The schedule table, as this adapter needs it (`AgentGraphStore`). */
export interface ScheduleRowAccess {
  listAllSchedules(): Promise<readonly ScheduleRow[]>;
  getSchedule(id: string): Promise<ScheduleRow | undefined>;
  setScheduleDeadline(id: string, until: Date, enable: boolean): Promise<ScheduleRow | undefined>;
  disableSchedule(id: string): Promise<boolean>;
  markScheduleRun(id: string): Promise<void>;
}

export interface ScheduleTriggerDeps {
  readonly service: () => TriggerService | undefined;
  readonly schedules: () => ScheduleRowAccess | undefined;
  /** A live agent by id. */
  readonly agentById: (agentId: string) => { readonly id: string; readonly slug: string } | undefined;
  readonly limits: () => TriggerLimits;
  /** An operator notice (audit + log) — a schedule has no person to ask. */
  readonly notice: (scheduleId: string, message: string) => void;
  readonly now?: () => Date;
  readonly log: (message: string) => void;
}

export interface ScheduleSyncResult {
  readonly armed: number;
  readonly ended: number;
  readonly expired: number;
}

export interface ScheduleTriggerScheduler {
  /** Bring every schedule's trigger in line with its row. */
  sync(): Promise<ScheduleSyncResult>;
  /** Re-enable a schedule with a fresh deadline (operator renewal). */
  renew(scheduleId: string, by: string): Promise<ScheduleRow | undefined>;
  /** A firing ran the schedule's turn: stamp the row. */
  ran(trigger: Trigger): Promise<void>;
  /** Is the schedule behind this trigger still enabled and in its deadline? */
  isLive(trigger: Trigger): Promise<boolean>;
}

/** The text a schedule's turn starts from. */
export function schedulePrompt(row: Pick<ScheduleRow, 'payload'>): string {
  const prompt = row.payload['prompt'];
  return typeof prompt === 'string' && prompt.trim() !== '' ? prompt : DEFAULT_PROMPT;
}

export function createScheduleTriggerScheduler(deps: ScheduleTriggerDeps): ScheduleTriggerScheduler {
  const clock = deps.now ?? (() => new Date());

  async function triggerOf(scheduleId: string): Promise<Trigger | undefined> {
    return (await deps.service()?.listForContext('schedule', scheduleId))?.[0];
  }

  async function expire(row: ScheduleRow, service: TriggerService): Promise<void> {
    const t = await triggerOf(row.id);
    if (t) await service.end(t.id, 'expired', { schedule: row.id });
    if (await deps.schedules()?.disableSchedule(row.id)) {
      deps.notice(row.id, `schedule ${row.id} (${row.cron}) reached its deadline and was disabled; renew it to run on`);
    }
  }

  async function arm(row: ScheduleRow, service: TriggerService, access: ScheduleRowAccess): Promise<boolean> {
    const agent = deps.agentById(row.agentId);
    if (!agent) return false;
    const limits = deps.limits();
    const now = clock();
    const gap = cronMinGapSeconds(row.cron, row.timezone, now);
    if (gap === undefined || gap < limits.minIntervalSeconds) {
      const why = `cron '${row.cron}' runs more often than every ${String(limits.minIntervalSeconds / 60)} minutes`;
      deps.log(`[schedules/triggers] schedule ${row.id}: ${why}; not armed`);
      deps.notice(row.id, `schedule ${row.id} could not be armed: ${why}`);
      return false;
    }
    const until = row.until ?? new Date(now.getTime() + limits.recurringMaxDays * DAY_MS);
    if (!row.until) await access.setScheduleDeadline(row.id, until, false);
    const res = await service
      .create(
        'wake_every',
        {
          purpose: `Agent Builder schedule: ${schedulePrompt(row).slice(0, 120)}`,
          cron: row.cron,
          timezone: row.timezone,
          until: until.toISOString(),
          max_runs: cronRunsUntil(row.cron, until, now, limits.maxRunsCap),
          actions: [{ type: 'turn', instruction: schedulePrompt(row) }],
          budget: {
            per_firing_usd: limits.perFiringUsdMax,
            total_usd: limits.perTriggerUsdMax,
            model_calls_per_firing: limits.modelCallsPerFiringMax,
          },
        },
        {
          agentId: agent.id,
          agentSlug: agent.slug,
          origin: 'system',
          ownerKey: null,
          contextKind: 'schedule',
          contextId: row.id,
          liveContext: false,
          deliveryChannel: null,
          deliveryRef: null,
          discretion: null,
          createdBy: `schedule:${row.id}`,
        },
      )
      .catch((err: unknown) => {
        // Another machine armed it first (one trigger per schedule).
        if ((err as { code?: string }).code === '23505') return undefined;
        throw err;
      });
    if (res && !res.ok) {
      deps.log(`[schedules/triggers] schedule ${row.id} not armed: ${res.code}: ${res.message}`);
      deps.notice(row.id, `schedule ${row.id} could not be armed: ${res.message}`);
      return false;
    }
    return res !== undefined;
  }

  async function sync(): Promise<ScheduleSyncResult> {
    const service = deps.service();
    const access = deps.schedules();
    if (!service || !access) return { armed: 0, ended: 0, expired: 0 };
    const now = clock();
    const rows = await access.listAllSchedules();
    const live = new Set<string>();
    let armed = 0;
    let expired = 0;
    for (const row of rows) {
      if (row.status !== 'enabled') continue;
      if (row.until && row.until.getTime() <= now.getTime()) {
        await expire(row, service);
        expired += 1;
        continue;
      }
      live.add(row.id);
      const existing = await triggerOf(row.id);
      if (existing) {
        if (row.until && existing.until.getTime() !== row.until.getTime()) {
          await service.renew(existing.id, row.until, `schedule:${row.id}`);
        }
        continue;
      }
      if (await arm(row, service, access)) armed += 1;
    }
    // A trigger whose schedule is gone or disabled ends with it.
    let ended = 0;
    for (const t of await service.listForContextKind('schedule')) {
      if (live.has(t.contextId)) continue;
      if (await service.end(t.id, 'cancelled', { schedule: t.contextId, why: 'schedule disabled or deleted' })) ended += 1;
    }
    return { armed, ended, expired };
  }

  return {
    sync,
    async renew(scheduleId, by) {
      const access = deps.schedules();
      if (!access) return undefined;
      const until = new Date(clock().getTime() + deps.limits().recurringMaxDays * DAY_MS);
      const row = await access.setScheduleDeadline(scheduleId, until, true);
      if (!row) return undefined;
      deps.log(`[schedules/triggers] schedule ${scheduleId} renewed until ${until.toISOString()} by ${by}`);
      await sync();
      return row;
    },
    async ran(trigger) {
      await deps.schedules()?.markScheduleRun(trigger.contextId);
    },
    async isLive(trigger) {
      const row = await deps.schedules()?.getSchedule(trigger.contextId);
      if (!row || row.status !== 'enabled') return false;
      return row.until === null || row.until.getTime() > clock().getTime();
    },
  };
}
