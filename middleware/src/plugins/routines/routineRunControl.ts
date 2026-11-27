/**
 * #1746 / #1747 / #1748 — control over a routine run while it is in flight:
 * one run per routine at a time (cron and "run now" share the lock), a real
 * timeout for every run, and cancellation when the owner pauses or deletes
 * the routine mid-run. The signal reaches the agent turn through
 * `turnContext.abortSignal`, so a cancelled run stops spending at the next
 * tool-loop iteration instead of running to the end.
 */

/**
 * The smallest per-run timeout the runner honours. A stored value below it
 * (rows from before the floor, or a tool call that asked for 1 s) is raised,
 * because no agent turn with a tool call finishes that fast: the run would
 * time out every time and look like an agent failure.
 */
export const MIN_ROUTINE_TIMEOUT_MS = 30_000;

/** The default per-run timeout (10 min), as `routineStore.create` stores it. */
export const DEFAULT_ROUTINE_TIMEOUT_MS = 600_000;

export function effectiveTimeoutMs(stored: number): number {
  return Math.max(stored, MIN_ROUTINE_TIMEOUT_MS);
}

/** Why a run was cancelled from outside: its routine changed under it. */
export type RoutineCancelCause = 'paused' | 'deleted';

/** The abort reason of a run whose routine was paused or deleted while it ran. */
export class RoutineRunCancelledError extends Error {
  constructor(public readonly cancelCause: RoutineCancelCause) {
    super(
      cancelCause === 'deleted'
        ? 'the routine was deleted while it ran; the run was cancelled'
        : 'the routine was paused while it ran; the run was cancelled and nothing was delivered',
    );
    this.name = 'RoutineRunCancelledError';
  }
}

/** The abort reason of a run that hit its timeout. */
export class RoutineRunTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`routine run timed out after ${String(Math.round(timeoutMs / 1000))} s`);
    this.name = 'RoutineRunTimeoutError';
  }
}

/** A manual run was asked for while another run of the routine is in flight. */
export class RoutineRunInProgressError extends Error {
  readonly code = 'routines.run_in_progress';
  constructor(id: string) {
    super(`routine '${id}' is already running; wait for the run to finish`);
    this.name = 'RoutineRunInProgressError';
  }
}

/** A signal that aborts with a {@link RoutineRunTimeoutError} after `timeoutMs`. */
export function timeoutSignal(timeoutMs: number): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new RoutineRunTimeoutError(timeoutMs)), timeoutMs);
  timer.unref?.();
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

/**
 * The runs in flight in this process, one per routine. `acquire` is
 * synchronous, so two firings in the same tick cannot both get the lock.
 */
export class InFlightRuns {
  private readonly runs = new Map<string, AbortController>();

  has(routineId: string): boolean {
    return this.runs.has(routineId);
  }

  /** The run's own controller, or undefined when one is already in flight. */
  acquire(routineId: string): AbortController | undefined {
    if (this.runs.has(routineId)) return undefined;
    const controller = new AbortController();
    this.runs.set(routineId, controller);
    return controller;
  }

  release(routineId: string, controller: AbortController): void {
    if (this.runs.get(routineId) === controller) this.runs.delete(routineId);
  }

  /** Cancel the routine's run in flight, if any. */
  cancel(routineId: string, cause: RoutineCancelCause): void {
    this.runs.get(routineId)?.abort(new RoutineRunCancelledError(cause));
  }
}

/** How an aborted run is recorded: a cancellation is not a timeout. */
export function abortedStatus(signal: AbortSignal): 'cancelled' | 'timeout' {
  return signal.reason instanceof RoutineRunCancelledError ? 'cancelled' : 'timeout';
}

export function abortMessage(signal: AbortSignal, fallback: string): string {
  return signal.reason instanceof Error ? signal.reason.message : fallback;
}
