import { randomUUID } from 'node:crypto';

import { cronMatchesInZone } from '../scheduler/zonedCron.js';
import { isValidCron } from '../scheduler/cron.js';
import type { ConductorSchedule, ConductorScheduleStore } from './scheduleStore.js';
import { WorkflowDisabledError, WorkflowNotFoundError, type ConductorRunExecutor } from './runExecutor.js';

const MINUTE_MS = 60_000;
const MAX_EXPIRED_MINUTES = 24 * 60;

/**
 * Fires Conductor workflows on their cron triggers (US4 cron / FR-007). Polls `conductor_schedules`
 * periodically and starts a run for each enabled schedule whose local cron matches the
 * current absolute minute. The DB advances the inspection and dispatch cursors atomically,
 * so the at-most-once claim holds across restarts and
 * replicas; an in-flight set additionally prevents overlapping startRun for the same schedule.
 * graphPool-gated by the caller, like the await/resume workers.
 */
export class ConductorScheduleWorker {
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticking = false;
  private readonly inFlight = new Set<string>();
  private readonly claimerId = randomUUID();

  constructor(
    private readonly deps: {
      scheduleStore: ConductorScheduleStore;
      executor: ConductorRunExecutor;
      intervalMs?: number;
      log?: (msg: string) => void;
    },
  ) {}

  start(): void {
    if (this.timer) return;
    // Poll several times per minute so crossing a minute boundary during the
    // query or starting the worker late does not strand a schedule at one phase.
    const interval = this.deps.intervalMs ?? 15_000;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), interval);
    if (typeof this.timer.unref === 'function') this.timer.unref();
    this.deps.log?.('[conductor] schedule worker started (cron poll)');
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      let schedules: ConductorSchedule[];
      try {
        schedules = await this.deps.scheduleStore.listForPoll();
      } catch (err) {
        this.deps.log?.(`[conductor] schedule worker list failed: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }

      const gaps: ConductorSchedule[] = [];
      for (const s of schedules) {
        let due: boolean;
        let invalid: string | undefined;
        try {
          if (!isValidCron(s.cron)) throw new Error('expected a valid five-field cron expression');
          due = cronMatchesInZone(s.cron, s.pollMinute, s.timezone);
        } catch (err) {
          due = false;
          invalid = err instanceof Error ? err.message : String(err);
        }
        const alreadyClaimed = s.lastRunAt !== null && s.lastRunAt >= s.pollMinute;
        const willFire = due && s.workflowEnabled && !this.inFlight.has(s.id) && !alreadyClaimed;
        let won: boolean;
        try {
          won = await this.deps.scheduleStore.claimPoll(s, this.claimerId, willFire);
        } catch (err) {
          this.deps.log?.(`[conductor] schedule worker claim ${s.id} failed: ${err instanceof Error ? err.message : String(err)}`);
          continue;
        }
        if (!won) continue;
        if (invalid !== undefined) {
          this.deps.log?.(`[conductor] schedule worker invalid cron or zone on ${s.id} (${s.cron}, ${s.timezone}): ${invalid}`);
          continue;
        }
        if (s.pollMinute.getTime() - s.lastCheckedAt.getTime() > MINUTE_MS) gaps.push(s);
        if (due && !willFire && !alreadyClaimed) {
          this.logSuppression(s, s.workflowEnabled ? 'start_in_flight' : 'workflow_or_schedule_disabled');
        }
        if (!willFire) continue;
        this.inFlight.add(s.id);
        void this.fire(s).finally(() => this.inFlight.delete(s.id));
      }
      // Process historical gaps after claiming the current minutes.
      for (const schedule of gaps) this.logExpiredSlots(schedule);
    } finally {
      this.ticking = false;
    }
  }

  private logExpiredSlots(s: ConductorSchedule): void {
    const end = s.pollMinute.getTime();
    const first = Math.max(s.lastCheckedAt.getTime() + MINUTE_MS, end - MAX_EXPIRED_MINUTES * MINUTE_MS);
    let count = 0;
    for (let slot = first; slot < end; slot += MINUTE_MS) {
      if (cronMatchesInZone(s.cron, new Date(slot), s.timezone)) count += 1;
    }
    const gap = (end - s.lastCheckedAt.getTime()) / MINUTE_MS - 1;
    if (count === 0 && gap <= MAX_EXPIRED_MINUTES) return;
    this.deps.log?.(
      `[conductor] cron suppressed 'missed_slots_expired' workflow='${s.workflowSlug}' schedule=${s.id} zone=${s.timezone} ` +
      `after=${s.lastCheckedAt.toISOString()} before=${s.pollMinute.toISOString()} matchingSlots=${count} uninspectedMinutes=${Math.max(0, gap - MAX_EXPIRED_MINUTES)}`,
    );
  }

  private logSuppression(s: ConductorSchedule, reason: string): void {
    this.deps.log?.(
      `[conductor] cron suppressed '${reason}' workflow='${s.workflowSlug}' schedule=${s.id} zone=${s.timezone} slot=${s.pollMinute.toISOString()}`,
    );
  }

  // At-most-once semantics: the slot is already claimed before this runs. Once startRun() creates the
  // durable conductor_runs row, a later drive crash is recovered by the resume worker. The only lost
  // window is a startRun() failure BEFORE that row exists (e.g. a transient DB error) — that single
  // occurrence is skipped rather than risk a double-fire by un-claiming. Acceptable for cron triggers.
  private async fire(s: ConductorSchedule): Promise<void> {
    try {
      this.deps.log?.(`[conductor] cron firing '${s.workflowSlug}' (${s.cron})`);
      await this.deps.executor.startRun({
        slug: s.workflowSlug,
        payload: {},
        triggerKind: 'cron',
        triggerSource: { scheduleId: s.id, cron: s.cron, timezone: s.timezone, slotAt: s.pollMinute.toISOString() },
      });
    } catch (err) {
      if (err instanceof WorkflowDisabledError || err instanceof WorkflowNotFoundError) {
        this.logSuppression(s, err instanceof WorkflowDisabledError ? 'workflow_disabled' : 'workflow_not_found');
      } else {
        this.deps.log?.(`[conductor] cron fire '${s.workflowSlug}' failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}
