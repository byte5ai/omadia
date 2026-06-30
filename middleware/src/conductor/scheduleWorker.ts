import { randomUUID } from 'node:crypto';

import { cronMatches } from '../scheduler/cron.js';
import type { ConductorSchedule, ConductorScheduleStore } from './scheduleStore.js';
import type { ConductorRunExecutor } from './runExecutor.js';

/**
 * Fires Conductor workflows on their cron triggers (US4 cron / FR-007). Polls `conductor_schedules`
 * once per minute and starts a run for each enabled schedule whose cron matches the current UTC
 * minute and whose workflow is enabled. Per-minute exactly-once is enforced in the DB
 * (`scheduleStore.claimRun` advances `last_run_at` atomically), so it holds across restarts and
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
      now?: () => Date;
      log?: (msg: string) => void;
    },
  ) {}

  start(): void {
    if (this.timer) return;
    const interval = this.deps.intervalMs ?? 60_000;
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
      const now = (this.deps.now ?? (() => new Date()))();
      let schedules: ConductorSchedule[];
      try {
        schedules = await this.deps.scheduleStore.listEnabled();
      } catch (err) {
        this.deps.log?.(`[conductor] schedule worker list failed: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }

      for (const s of schedules) {
        if (!s.workflowEnabled) continue;
        if (this.inFlight.has(s.id)) continue;

        // A malformed cron on a legacy/manual row must not abort the whole tick (which would skip
        // every later schedule this minute) — guard each match and skip only the bad row.
        let due: boolean;
        try {
          due = cronMatches(s.cron, now);
        } catch (err) {
          this.deps.log?.(`[conductor] schedule worker bad cron '${s.cron}' on ${s.id}: ${err instanceof Error ? err.message : String(err)}`);
          continue;
        }
        if (!due) continue;

        let won: boolean;
        try {
          won = await this.deps.scheduleStore.claimRun(s.id, this.claimerId);
        } catch (err) {
          this.deps.log?.(`[conductor] schedule worker claim ${s.id} failed: ${err instanceof Error ? err.message : String(err)}`);
          continue;
        }
        if (!won) continue; // another tick/replica already fired this minute

        this.inFlight.add(s.id);
        void this.fire(s).finally(() => this.inFlight.delete(s.id));
      }
    } finally {
      this.ticking = false;
    }
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
        triggerSource: { scheduleId: s.id, cron: s.cron },
      });
    } catch (err) {
      this.deps.log?.(`[conductor] cron fire '${s.workflowSlug}' failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
