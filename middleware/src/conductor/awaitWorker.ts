import type { ConductorAwaitStore } from './awaitStore.js';
import type { ConductorRunExecutor } from './runExecutor.js';

/**
 * Polls `conductor_awaits` on a minute tick and expires any waiting await whose deadline has
 * passed — firing the human step's in-graph fallback transition (FR-017). Reminders (which need
 * proactive channel notification) are a later addition; this worker handles the deadline path.
 * graphPool-gated by the caller (only started when Postgres is available).
 */
export class ConductorAwaitWorker {
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly deps: {
      awaitStore: ConductorAwaitStore;
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
    this.deps.log?.('[conductor] await worker started (deadline poll)');
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async tick(): Promise<void> {
    const now = (this.deps.now ?? (() => new Date()))();
    let due;
    try {
      due = await this.deps.awaitStore.listDue(now);
    } catch (err) {
      this.deps.log?.(`[conductor] await worker list failed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    for (const aw of due) {
      try {
        await this.deps.executor.expireAwait(aw.id);
      } catch (err) {
        this.deps.log?.(`[conductor] await worker expire ${aw.id} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}
