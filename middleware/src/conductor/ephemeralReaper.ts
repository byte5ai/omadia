// Ephemeral-workflow reaper (#330 Workstream A). Same worker discipline as
// scheduleWorker.ts: unref'd interval, a `ticking` re-entrancy flag, injectable
// now/log/interval, and per-row error isolation (one bad row never aborts the
// tick). Disposal semantics: an expired workflow first gets a #759
// cancel-request for its still-active runs (honoured at the next step
// boundary), then the definition is logically reaped (disabled + reaped_at);
// a physical DELETE only happens for rows no run references — the run history
// and version graph are the retained audit trace.

import type { ConductorEphemeralStore } from './ephemeralStore.js';

const REAPER_ACTOR = 'conductor-ephemeral-reaper';

export class ConductorEphemeralReaper {
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticking = false;

  constructor(
    private readonly deps: {
      store: ConductorEphemeralStore;
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
    this.deps.log?.('[conductor] ephemeral reaper started');
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
      let reapable;
      try {
        reapable = await this.deps.store.listReapable(now);
      } catch (err) {
        this.deps.log?.(`[conductor] ephemeral reaper list failed: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }

      for (const wf of reapable) {
        try {
          if (wf.expired) {
            const cancelled = await this.deps.store.requestCancelActiveRuns(wf.id, REAPER_ACTOR);
            if (cancelled > 0) {
              this.deps.log?.(`[conductor] ephemeral '${wf.slug}' expired — cancel requested for ${cancelled} active run(s)`);
            }
          }
          await this.deps.store.markReaped(wf.id);
          const deleted = await this.deps.store.hardDeleteUnreferenced(wf.id);
          this.deps.log?.(
            `[conductor] ephemeral '${wf.slug}' reaped (${deleted ? 'deleted — no runs referenced it' : 'definition retained as audit trace'})`,
          );
        } catch (err) {
          this.deps.log?.(`[conductor] ephemeral reap of '${wf.slug}' failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } finally {
      this.ticking = false;
    }
  }
}
