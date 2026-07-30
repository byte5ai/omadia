/**
 * W2-2 criterion 7 — orphan handling for long-running tasks.
 *
 * A task nobody polls must not leak a `working` row forever. Two distinct
 * leaks exist and both are swept here, mirroring the two-tier shape of
 * `devplatform/retention.ts`:
 *
 *  1. ABANDONED live tasks. The worker crashed, the process restarted mid-run,
 *     or the runner was never started at all. The row stays `working` with a
 *     frozen heartbeat and the model's `_status` poll answers "working" forever
 *     — a lie. These are force-failed with an explicit error, so a poll gets the
 *     truth.
 *
 *  2. ACCUMULATED terminal tasks. Nothing ever deletes a `completed` row: the
 *     model may never poll it, and even when it does, it does not clean up.
 *     Terminal rows older than the retain window are purged.
 *
 * The sweep itself lives on the store (`TaskStore.reapOrphans`) so a Postgres
 * implementor can do it in two statements. This module only owns the SCHEDULE,
 * kept separate so the sweep stays unit-testable against a driven clock.
 */

import type { TaskReapResult, TaskStore } from './taskTypes.js';

/** Default: a live task silent for 15 min is abandoned. Long enough for a slow
 *  sub-agent turn, short enough that a crashed worker is not believed for long. */
export const DEFAULT_TASK_STALE_AFTER_MS = 15 * 60_000;

/** Default: a finished task is retained an hour, so a following turn can still
 *  collect its result, then purged. */
export const DEFAULT_TASK_PURGE_TERMINAL_AFTER_MS = 60 * 60_000;

/** Default sweep cadence. */
export const DEFAULT_TASK_REAP_INTERVAL_MS = 5 * 60_000;

export interface TaskReaperOptions {
  readonly staleAfterMs?: number;
  readonly purgeTerminalAfterMs?: number;
  readonly intervalMs?: number;
  readonly onSweep?: (result: TaskReapResult) => void;
  readonly onError?: (err: unknown) => void;
}

/** Run exactly one sweep. Exported so a test can drive it without timers. */
export async function runTaskReaperOnce(
  store: TaskStore,
  opts: TaskReaperOptions = {},
  now?: Date,
): Promise<TaskReapResult> {
  return store.reapOrphans({
    ...(now !== undefined ? { now } : {}),
    staleAfterMs: opts.staleAfterMs ?? DEFAULT_TASK_STALE_AFTER_MS,
    purgeTerminalAfterMs:
      opts.purgeTerminalAfterMs ?? DEFAULT_TASK_PURGE_TERMINAL_AFTER_MS,
  });
}

/**
 * Start the periodic sweep. Returns a dispose function.
 *
 * The timer is `unref`'d so it never keeps the process alive on shutdown — a
 * pending reap is not worth delaying an exit for; the next boot sweeps anyway.
 */
export function startTaskReaper(
  store: TaskStore,
  opts: TaskReaperOptions = {},
): () => void {
  const intervalMs = opts.intervalMs ?? DEFAULT_TASK_REAP_INTERVAL_MS;
  const timer = setInterval(() => {
    void runTaskReaperOnce(store, opts).then(
      (result) => opts.onSweep?.(result),
      (err: unknown) => {
        if (opts.onError) opts.onError(err);
        else console.warn('[taskReaper] sweep failed:', err);
      },
    );
  }, intervalMs);
  timer.unref?.();
  return (): void => {
    clearInterval(timer);
  };
}
