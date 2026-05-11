import { Cron } from 'croner';

import {
  JOB_DEFAULT_TIMEOUT_MS,
  JobAlreadyRegisteredError,
  JobValidationError,
  type JobHandler,
  type JobSpec,
} from '@omadia/plugin-api';

/**
 * Kernel-internal scheduler for plugin background jobs.
 *
 * Each registered job is keyed by `(agentId, name)`. A job is active from
 * `register()` until `dispose()` (or the plugin's bulk `stopForPlugin()` on
 * deactivate). Cron-scheduled jobs use {@link https://croner.56k.guru | croner}
 * (small, dep-free, well-tested); interval-scheduled jobs use a setInterval
 * loop. Both surface the same lifecycle.
 *
 * Per-run isolation:
 *   - Each tick runs the handler with a fresh `AbortController`. The signal
 *     fires when (a) the handler exceeds `timeoutMs` or (b) the plugin
 *     deactivates while the run is in flight.
 *   - Handlers that throw or reject are logged and dropped — the next tick
 *     fires regardless. (Treating a throw as fatal would let a transient
 *     network blip silently kill a sync loop. Operators stop a misbehaving
 *     job by deactivating the plugin.)
 *
 * Overlap policy (per job, see {@link JobSpec.overlap}):
 *   - `'skip'` (default): if the previous run is still in flight when the
 *     trigger fires, the new tick is dropped. Suits idempotent sync jobs.
 *   - `'queue'`: enqueues exactly one pending run. Further ticks while still
 *     queued fall back to skip — no unbounded backlog.
 *
 * The scheduler does not persist anything across process restarts. A job
 * that fires every 5 minutes will re-fire 0–5 minutes after boot, depending
 * on cron alignment. This matches existing implicit behaviour (the kernel
 * never had a job ledger).
 */

interface Registered {
  agentId: string;
  spec: JobSpec;
  handler: JobHandler;
  /** Whether a run is currently executing. */
  running: boolean;
  /** Whether a `'queue'` overlap caused a pending run to be enqueued. */
  pending: boolean;
  /** Timer / cron handle owned by this registration. */
  trigger: { stop: () => void };
  /** Active run's controller, if any — fires on timeout or stopForPlugin. */
  abortController: AbortController | null;
}

export interface JobSchedulerOptions {
  log?: (msg: string) => void;
  /** Test-only seam. Defaults to global setTimeout/clearTimeout/setInterval. */
  timers?: TimerSeam;
}

export interface TimerSeam {
  setTimeout(cb: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(cb: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

const REAL_TIMERS: TimerSeam = {
  setTimeout: (cb, ms) => globalThis.setTimeout(cb, ms),
  clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
  setInterval: (cb, ms) => globalThis.setInterval(cb, ms),
  clearInterval: (h) =>
    globalThis.clearInterval(h as ReturnType<typeof setInterval>),
};

export class JobScheduler {
  /** Composite key: `${agentId}\n${name}`. The newline avoids id collisions
   *  if a plugin id ever contains characters that look like a name. */
  private readonly entries = new Map<string, Registered>();
  private readonly log: (msg: string) => void;
  private readonly timers: TimerSeam;

  constructor(opts: JobSchedulerOptions = {}) {
    this.log = opts.log ?? ((m) => console.log(m));
    this.timers = opts.timers ?? REAL_TIMERS;
  }

  /** Register a job. Throws on validation error or duplicate name within the
   *  same plugin. Returns a dispose handle. */
  register(agentId: string, spec: JobSpec, handler: JobHandler): () => void {
    validateSpec(agentId, spec);
    const key = compositeKey(agentId, spec.name);
    if (this.entries.has(key)) {
      throw new JobAlreadyRegisteredError(agentId, spec.name);
    }

    const entry: Registered = {
      agentId,
      spec,
      handler,
      running: false,
      pending: false,
      trigger: { stop: () => {} },
      abortController: null,
    };

    entry.trigger = this.makeTrigger(entry);
    this.entries.set(key, entry);
    return () => this.dispose(key);
  }

  /** Stop and unregister every job belonging to a plugin. Aborts in-flight
   *  runs via their AbortSignal; the runs may finish post-abort if their
   *  handlers don't honour the signal — that's a plugin bug, not the
   *  scheduler's. Idempotent. */
  stopForPlugin(agentId: string): void {
    for (const key of [...this.entries.keys()]) {
      const entry = this.entries.get(key);
      if (entry?.agentId === agentId) this.dispose(key);
    }
  }

  /** Snapshot of registered jobs. Used by tests and diagnostics. */
  list(): Array<{ agentId: string; name: string; running: boolean }> {
    return [...this.entries.values()].map((e) => ({
      agentId: e.agentId,
      name: e.spec.name,
      running: e.running,
    }));
  }

  private dispose(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    try {
      entry.trigger.stop();
    } catch (err) {
      this.log(
        `[job-scheduler] stop trigger failed for ${entry.agentId}/${entry.spec.name}: ${errorMessage(err)}`,
      );
    }
    if (entry.abortController) {
      entry.abortController.abort();
    }
  }

  private makeTrigger(entry: Registered): { stop: () => void } {
    const fire = (): void => {
      this.tick(entry);
    };
    const sched = entry.spec.schedule;
    if ('cron' in sched) {
      const cron = new Cron(sched.cron, fire);
      return { stop: () => cron.stop() };
    }
    const handle = this.timers.setInterval(fire, sched.intervalMs);
    return { stop: () => this.timers.clearInterval(handle) };
  }

  private tick(entry: Registered): void {
    if (entry.running) {
      const overlap = entry.spec.overlap ?? 'skip';
      if (overlap === 'queue' && !entry.pending) {
        entry.pending = true;
      }
      // Default 'skip' (or queue already saturated): drop this tick.
      return;
    }
    void this.runOnce(entry);
  }

  private async runOnce(entry: Registered): Promise<void> {
    entry.running = true;
    const controller = new AbortController();
    entry.abortController = controller;
    const timeoutMs = entry.spec.timeoutMs ?? JOB_DEFAULT_TIMEOUT_MS;
    const timer = this.timers.setTimeout(() => {
      controller.abort(new Error(`job '${entry.spec.name}' exceeded ${timeoutMs}ms`));
    }, timeoutMs);

    try {
      await entry.handler(controller.signal);
    } catch (err) {
      this.log(
        `[job-scheduler] ${entry.agentId}/${entry.spec.name} threw: ${errorMessage(err)}`,
      );
    } finally {
      this.timers.clearTimeout(timer);
      entry.abortController = null;
      entry.running = false;
    }

    // Drain a queued tick if one piled up while we were running.
    if (entry.pending && this.entries.has(compositeKey(entry.agentId, entry.spec.name))) {
      entry.pending = false;
      void this.runOnce(entry);
    }
  }
}

function compositeKey(agentId: string, name: string): string {
  return `${agentId}\n${name}`;
}

function validateSpec(agentId: string, spec: JobSpec): void {
  if (!spec.name || typeof spec.name !== 'string') {
    throw new JobValidationError(
      `plugin '${agentId}' job spec missing 'name'`,
    );
  }
  const sched = spec.schedule;
  if (!sched || typeof sched !== 'object') {
    throw new JobValidationError(
      `plugin '${agentId}' job '${spec.name}' missing schedule`,
    );
  }
  if ('cron' in sched) {
    if (typeof sched.cron !== 'string' || sched.cron.trim().length === 0) {
      throw new JobValidationError(
        `plugin '${agentId}' job '${spec.name}' cron expression must be a non-empty string`,
      );
    }
    // Cheap sanity check via croner constructor — throws on malformed cron.
    try {
      const probe = new Cron(sched.cron, { paused: true });
      probe.stop();
    } catch (err) {
      throw new JobValidationError(
        `plugin '${agentId}' job '${spec.name}' cron '${sched.cron}' is invalid: ${errorMessage(err)}`,
      );
    }
  } else if ('intervalMs' in sched) {
    if (
      typeof sched.intervalMs !== 'number' ||
      !Number.isFinite(sched.intervalMs) ||
      sched.intervalMs <= 0
    ) {
      throw new JobValidationError(
        `plugin '${agentId}' job '${spec.name}' intervalMs must be a positive finite number`,
      );
    }
  } else {
    throw new JobValidationError(
      `plugin '${agentId}' job '${spec.name}' schedule must be {cron} or {intervalMs}`,
    );
  }
  if (
    spec.timeoutMs !== undefined &&
    (!Number.isFinite(spec.timeoutMs) || spec.timeoutMs <= 0)
  ) {
    throw new JobValidationError(
      `plugin '${agentId}' job '${spec.name}' timeoutMs must be a positive finite number`,
    );
  }
  if (spec.overlap !== undefined && spec.overlap !== 'skip' && spec.overlap !== 'queue') {
    throw new JobValidationError(
      `plugin '${agentId}' job '${spec.name}' overlap must be 'skip' or 'queue'`,
    );
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
