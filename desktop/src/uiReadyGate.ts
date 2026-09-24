/**
 * Wait for the web UI to say it is standing (OM-71 / #1005).
 *
 * `win.loadURL()` resolves when the document finished loading. For the web UI
 * that is the moment it renders "Loading login…" and starts hydrating, so the
 * recovery-key reminder fired over a page that was not there yet. The renderer
 * pings `omadia:uiReady` (preload bridge) once its first real screen is up; this
 * gate turns that ping into something a boot sequence can await.
 *
 * Bounded on purpose: a web UI that never pings (an older build in a mixed
 * update, a renderer that died before hydrating) still gets its reminder after
 * `fallbackMs`. The reminder exists to prevent silent data loss, so "late" beats
 * "never".
 */

export type UiReadyOutcome = 'signal' | 'fallback' | 'superseded';

/** Injectable timers so the gate is testable without waiting. */
export interface GateTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface UiReadyGate {
  /**
   * Start waiting. Call BEFORE `loadURL`, so a fast renderer cannot ping before
   * anyone listens. A later `arm()` resolves the previous one as `superseded`.
   */
  arm(): Promise<UiReadyOutcome>;
  /** The renderer's ping. Ignored when nothing is armed. */
  signal(): void;
}

interface Pending {
  readonly resolve: (outcome: UiReadyOutcome) => void;
  readonly timer: unknown;
}

const defaultTimers: GateTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function createUiReadyGate(
  fallbackMs: number,
  timers: GateTimers = defaultTimers,
): UiReadyGate {
  let pending: Pending | null = null;

  const settle = (outcome: UiReadyOutcome): void => {
    if (pending === null) return;
    const current = pending;
    pending = null;
    timers.clearTimeout(current.timer);
    current.resolve(outcome);
  };

  return {
    arm() {
      settle('superseded');
      return new Promise<UiReadyOutcome>((resolve) => {
        const timer = timers.setTimeout(() => settle('fallback'), fallbackMs);
        pending = { resolve, timer };
      });
    },
    signal() {
      settle('signal');
    },
  };
}
