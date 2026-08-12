/**
 * Issue #560, criterion 3 — the boot + periodic RESUME driver for long-running
 * tasks.
 *
 * ## Why this exists
 *
 * `startRunner(taskId)` is called from exactly one place — inside `_start`, for
 * the task it just created. There was no other driver: nothing ever calls
 * `claimNextPending` WITHOUT a task-id hint, so no task the current process did
 * not itself start in this run could ever be picked up. Against
 * {@link InMemoryTaskStore} that is invisible (its rows die with the process),
 * but against a durable store it is the whole gap the issue is about — a
 * persisted `working` row a restart orphaned, or a task a later turn un-parked
 * with `store.provideInput`, sits claimable and unclaimed forever.
 *
 * This driver closes it. It loops each tool's `resumeOne()` — which claims one
 * unclaimed `working` task of that kind (no hint) and drives it — until nothing
 * is claimable, at boot and then on an interval.
 *
 * ## What it does and does NOT recover
 *
 * It recovers tasks that are `working` with NO lease: never-claimed rows (the
 * crash window between `store.create` and the detached runner's claim) and
 * un-parked rows (`provideInput` flipped `input_required` → `working`).
 *
 * It does NOT steal a live-but-stale lease. A task orphaned MID-EXECUTE keeps
 * its dead worker's `claimed_by`, so `claimNextPending` (unclaimed-only) skips
 * it and re-running its executor from the persisted input is never attempted —
 * a partially-run, non-idempotent executor must not be blindly re-driven. Those
 * rows are the reaper's job: it force-fails them as abandoned
 * (`taskReaper.ts`), so a poll gets the truth rather than a silent re-run. The
 * two drivers are deliberately complementary — resume what is safe to resume,
 * fail what is not.
 */

/** The subset of a `LongRunningToolHandle` this driver needs — narrow so a test
 *  can drive it with a fake. */
export interface ResumableTaskSource {
  /** Claim and drive ONE claimable task of this source's kind; `true` if it ran
   *  one, `false` if nothing was claimable. */
  resumeOne(): Promise<boolean>;
}

/** Default cadence for the periodic resume sweep. Matches the reaper's, so the
 *  two background sweeps tick on the same rough schedule. */
export const DEFAULT_TASK_RESUME_INTERVAL_MS = 5 * 60_000;

/**
 * Backstop on tasks driven per source per sweep. A sweep drives at most this
 * many, so a runaway store that always answers "one more is claimable" cannot
 * turn a single sweep into an unbounded loop. The remainder is picked up on the
 * next tick.
 */
export const DEFAULT_TASK_RESUME_MAX_PER_SWEEP = 100;

export interface TaskResumeDriverOptions {
  readonly intervalMs?: number;
  readonly maxPerSweep?: number;
  /** Called after each sweep with how many tasks it drove (0 is common). */
  readonly onSweep?: (resumed: number) => void;
  readonly onError?: (err: unknown) => void;
}

/**
 * Drain every source once: drive each source's `resumeOne()` until it reports
 * nothing claimable or the per-source cap is hit. Exported so a test can run one
 * sweep without timers. Returns the total number of tasks driven.
 */
export async function runTaskResumeOnce(
  sources: readonly ResumableTaskSource[],
  opts: TaskResumeDriverOptions = {},
): Promise<number> {
  const cap = opts.maxPerSweep ?? DEFAULT_TASK_RESUME_MAX_PER_SWEEP;
  let resumed = 0;
  for (const source of sources) {
    for (let i = 0; i < cap; i += 1) {
      // Awaited on purpose: draining serially keeps the sweep bounded and
      // non-overlapping. A durable resume runs detached from any turn already,
      // so there is no latency budget to protect here.
      const ran = await source.resumeOne();
      if (!ran) break;
      resumed += 1;
    }
  }
  return resumed;
}

/**
 * Start the boot + periodic resume driver. Returns a dispose function.
 *
 * Fires ONE sweep immediately (the boot resume — the point of the whole unit)
 * without blocking the caller, then repeats on the interval. Like the reaper,
 * sweeps do not overlap and the timer is `unref`'d so a pending sweep never
 * holds the process open on shutdown; the next boot resumes anyway.
 */
export function startTaskResumeDriver(
  sources: readonly ResumableTaskSource[],
  opts: TaskResumeDriverOptions = {},
): () => void {
  const intervalMs = opts.intervalMs ?? DEFAULT_TASK_RESUME_INTERVAL_MS;
  let sweeping = false;
  const sweep = (): void => {
    if (sweeping) return;
    sweeping = true;
    void runTaskResumeOnce(sources, opts)
      .then(
        (resumed) => opts.onSweep?.(resumed),
        (err: unknown) => {
          if (opts.onError) opts.onError(err);
          else console.warn('[taskResumeDriver] resume sweep failed:', err);
        },
      )
      .finally(() => {
        sweeping = false;
      });
  };
  // Boot resume — detached so it never delays startup.
  sweep();
  const timer = setInterval(sweep, intervalMs);
  timer.unref?.();
  return (): void => {
    clearInterval(timer);
  };
}
