/**
 * PreviewRebuildScheduler — coalesces draft mutations into at most one
 * preview rebuild per debounce-window per (user, draft).
 *
 * Use case: as the spec/slot-patch endpoints land in B.4, every PATCH /draft
 * call wants to keep the preview in sync without rebuilding on every keystroke.
 * The pattern from the briefing is:
 *
 *   1. invalidate the cached PreviewHandle immediately (so a chat-turn never
 *      runs against stale generated code)
 *   2. schedule a rebuild after N ms; collapse subsequent mutations into the
 *      same scheduled run
 *
 * The scheduler does NOT touch the build pipeline directly — the caller
 * supplies an async `rebuild(userEmail, draftId)` callback. That keeps the
 * scheduler test-isolatable and makes it trivial to swap rebuilds for a
 * different strategy later (e.g. lazy-on-next-chat-turn).
 *
 * `cancelAll()` is required at SIGTERM so timers don't keep the event loop
 * alive after Express closes its server.
 */

export interface PreviewRebuildSchedulerDeps {
  /** Debounce window in ms — a fresh schedule() call within this window
   *  resets the timer. Default: 2000. */
  debounceMs?: number;
  /** Called the moment schedule() fires — typically wraps
   *  `previewCache.invalidate(...)`. */
  invalidate: (userEmail: string, draftId: string) => void;
  /** Called when the timer expires. Errors are caught + forwarded to
   *  `onError` (or logged via the default logger). */
  rebuild: (userEmail: string, draftId: string) => Promise<void>;
  onError?: (
    userEmail: string,
    draftId: string,
    err: unknown,
  ) => void;
  /** Test override — replaces setTimeout/clearTimeout. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

const DEFAULT_DEBOUNCE_MS = 2000;

export class PreviewRebuildScheduler {
  private readonly debounceMs: number;
  private readonly invalidateFn: PreviewRebuildSchedulerDeps['invalidate'];
  private readonly rebuildFn: PreviewRebuildSchedulerDeps['rebuild'];
  private readonly onError: NonNullable<PreviewRebuildSchedulerDeps['onError']>;
  private readonly setTimer: NonNullable<PreviewRebuildSchedulerDeps['setTimer']>;
  private readonly clearTimer: NonNullable<PreviewRebuildSchedulerDeps['clearTimer']>;
  private readonly timers = new Map<string, unknown>();

  constructor(deps: PreviewRebuildSchedulerDeps) {
    this.debounceMs = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.invalidateFn = deps.invalidate;
    this.rebuildFn = deps.rebuild;
    this.onError =
      deps.onError ??
      ((u, d, err) => {
        console.error(
          `[preview-rebuild] rebuild failed for user=${u} draft=${d}:`,
          err,
        );
      });
    this.setTimer =
      deps.setTimer ??
      ((fn, ms) => {
        const handle = setTimeout(fn, ms);
        // Don't keep the event loop alive purely for a debounced rebuild.
        // If the process exits cleanly, the rebuild is dropped — the next
        // mutation re-arms a fresh one.
        if (typeof (handle as { unref?: () => unknown }).unref === 'function') {
          (handle as { unref: () => unknown }).unref();
        }
        return handle;
      });
    this.clearTimer =
      deps.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  /**
   * Mark the (user, draft) preview as stale and arm a debounced rebuild.
   * Calling again before the timer fires resets the window.
   */
  schedule(userEmail: string, draftId: string): void {
    const key = makeKey(userEmail, draftId);
    const existing = this.timers.get(key);
    if (existing !== undefined) {
      this.clearTimer(existing);
    }
    this.invalidateFn(userEmail, draftId);
    const handle = this.setTimer(() => {
      this.timers.delete(key);
      this.rebuildFn(userEmail, draftId).catch((err: unknown) => {
        this.onError(userEmail, draftId, err);
      });
    }, this.debounceMs);
    this.timers.set(key, handle);
  }

  /** Cancel a pending rebuild without invalidating (e.g. user reverted). */
  cancel(userEmail: string, draftId: string): boolean {
    const key = makeKey(userEmail, draftId);
    const existing = this.timers.get(key);
    if (existing === undefined) return false;
    this.clearTimer(existing);
    this.timers.delete(key);
    return true;
  }

  /** Cancel everything — call at SIGTERM. */
  cancelAll(): number {
    let n = 0;
    for (const handle of this.timers.values()) {
      this.clearTimer(handle);
      n += 1;
    }
    this.timers.clear();
    return n;
  }

  size(): number {
    return this.timers.size;
  }
}

function makeKey(userEmail: string, draftId: string): string {
  return `${userEmail}::${draftId}`;
}
