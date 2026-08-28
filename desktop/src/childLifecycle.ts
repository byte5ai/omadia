/**
 * Stopping a child process and reporting, truthfully, whether it is gone.
 *
 * Extracted from Supervisor so the lifecycle transitions behind the macOS
 * update loop can be tested without booting Electron (#932).
 */

/** How a stop attempt actually ended. */
export type ChildStopOutcome = 'already-exited' | 'exited' | 'deadline';

/** The slice of ChildProcess this module needs, so tests can pass a double. */
export interface StoppableChild {
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: 'exit', listener: () => void): unknown;
}

export interface StopLogger {
  warn(message: string): void;
}

export const DEFAULT_GRACE_MS = 4_000;

/**
 * SIGTERM a child, wait for it to exit, escalate to SIGKILL, and say which of
 * those actually happened.
 *
 * The unconditional backstop is deliberate and stays: a quit must never hang
 * forever on a child whose 'exit' event never fires. What was missing is the
 * *distinction*. "I stopped waiting" used to resolve identically to "the
 * process is gone", so the updater handed a still-running kernel and Postgres
 * to Squirrel, ShipIt could not replace a bundle that was still in use, and
 * the same version was offered again on the next launch with no error logged
 * anywhere (#926, root cause #927). Callers that must know the stack is really
 * down can now ask.
 */
export function stopChild(
  child: StoppableChild | null,
  label: string,
  logger: StopLogger,
  graceMs: number = DEFAULT_GRACE_MS,
): Promise<ChildStopOutcome> {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve('already-exited');
  }
  return new Promise<ChildStopOutcome>((resolve) => {
    let settled = false;
    const finish = (outcome: ChildStopOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      clearTimeout(hardStop);
      resolve(outcome);
    };

    child.once('exit', () => finish('exited'));
    child.kill('SIGTERM');

    // Escalate if it ignores SIGTERM (notably on Windows, where SIGTERM is not
    // a real graceful signal).
    const killTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        logger.warn(`[${label}] did not exit on SIGTERM; sending SIGKILL`);
        child.kill('SIGKILL');
      }
    }, graceMs);

    const hardStop = setTimeout(() => {
      logger.warn(
        `[${label}] still alive ${graceMs * 2}ms after SIGTERM - giving up waiting. ` +
          'It may still hold files inside the app bundle.',
      );
      finish('deadline');
    }, graceMs * 2);
  });
}

/** True only when the process is confirmed gone, not merely given up on. */
export function isConfirmedStopped(outcome: ChildStopOutcome): boolean {
  return outcome !== 'deadline';
}
