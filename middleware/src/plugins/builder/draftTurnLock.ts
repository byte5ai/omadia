/**
 * #2214 — at most one builder turn per draft, and a way to stop it.
 *
 * Since #1899 a builder turn keeps running after its HTTP client disconnects
 * (until it ends or hits the turn timeout). Without a lock, a reload plus a
 * resend started a second turn on the same draft while the first one still
 * wrote the transcript and the spec: whichever turn wrote last won (#1804).
 *
 * The lock rejects instead of queueing. A second request on a busy draft gets
 * the running turn's id back, so the client re-attaches to it through the
 * resume endpoint. Waiting would hold an HTTP request open for up to the
 * turn timeout, and the queued message would then run against a spec the
 * operator has not seen yet: the answer of the first turn decides whether
 * the second message still makes sense.
 *
 * Every lock carries an `AbortController`. `stop()` aborts it; the builder
 * agent ends the turn at once, refuses further tool calls of that turn and
 * cancels its pending choice cards. The holder releases the lock when its
 * turn has ended, so `whenReleased()` lets a stop request wait for that.
 *
 * State is in memory, like the turn ring buffer and the choice coordinator:
 * a turn does not survive a restart either, so neither does its lock.
 */

/** Who started the turn: the chat route or an AutoFix trigger. */
export type DraftTurnSource = 'chat' | 'auto_fix';

/** Why a turn was aborted. Carried as the `AbortSignal` reason. */
export type DraftTurnStopReason = 'operator' | 'timeout';

export interface ActiveDraftTurn {
  readonly draftId: string;
  readonly turnId: string;
  readonly userEmail: string;
  readonly source: DraftTurnSource;
  readonly startedAt: number;
}

export interface DraftTurnLease {
  readonly turn: ActiveDraftTurn;
  /** Aborted by `stop()` (or the holder's own timeout). */
  readonly signal: AbortSignal;
  /** Abort this lease's own turn (used by the route's turn timeout). */
  abort(reason: DraftTurnStopReason): void;
  /** Idempotent. Frees the draft for the next turn. */
  release(): void;
}

export type DraftTurnAcquireResult =
  | { readonly ok: true; readonly lease: DraftTurnLease }
  | { readonly ok: false; readonly running: ActiveDraftTurn };

export type DraftTurnStopResult =
  | { readonly status: 'stopping'; readonly turn: ActiveDraftTurn }
  | { readonly status: 'not_running' };

interface LockEntry {
  readonly turn: ActiveDraftTurn;
  readonly controller: AbortController;
  readonly released: Promise<void>;
  readonly markReleased: () => void;
}

export interface DraftTurnLockOptions {
  /** Test seam for `startedAt`. */
  readonly now?: () => number;
}

export class DraftTurnLock {
  private readonly entries = new Map<string, LockEntry>();
  private readonly now: () => number;

  constructor(opts: DraftTurnLockOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
  }

  /** Take the draft for `turnId`, or report the turn that holds it. */
  tryAcquire(input: {
    draftId: string;
    turnId: string;
    userEmail: string;
    source: DraftTurnSource;
  }): DraftTurnAcquireResult {
    const existing = this.entries.get(input.draftId);
    if (existing) return { ok: false, running: existing.turn };

    let markReleased: () => void = () => {};
    const released = new Promise<void>((resolve) => {
      markReleased = resolve;
    });
    const entry: LockEntry = {
      turn: { ...input, startedAt: this.now() },
      controller: new AbortController(),
      released,
      markReleased,
    };
    this.entries.set(input.draftId, entry);

    const lease: DraftTurnLease = {
      turn: entry.turn,
      signal: entry.controller.signal,
      abort: (reason) => {
        abortOnce(entry.controller, reason);
      },
      release: () => {
        // Only the holder's own entry: a stale lease must never free a lock a
        // later turn took.
        if (this.entries.get(input.draftId) === entry) {
          this.entries.delete(input.draftId);
        }
        entry.markReleased();
      },
    };
    return { ok: true, lease };
  }

  /** The turn running on `draftId`, if any. */
  running(draftId: string): ActiveDraftTurn | undefined {
    return this.entries.get(draftId)?.turn;
  }

  /**
   * Abort the running turn of `draftId`. With `turnId`, only that turn: a
   * stop aimed at a turn that has already ended must not hit its successor.
   */
  stop(draftId: string, turnId?: string): DraftTurnStopResult {
    const entry = this.entries.get(draftId);
    if (!entry) return { status: 'not_running' };
    if (turnId !== undefined && entry.turn.turnId !== turnId) {
      return { status: 'not_running' };
    }
    abortOnce(entry.controller, 'operator');
    return { status: 'stopping', turn: entry.turn };
  }

  /**
   * Resolves `true` once the lock of `turnId` on `draftId` is released (at
   * once when it is not held), `false` when `timeoutMs` passes first.
   */
  async whenReleased(
    draftId: string,
    turnId: string,
    timeoutMs: number,
  ): Promise<boolean> {
    const entry = this.entries.get(draftId);
    if (!entry || entry.turn.turnId !== turnId) return true;
    let timer: NodeJS.Timeout | undefined;
    // Not unref'd: a caller (the stop request) is waiting on this, and the
    // wait is bounded by `timeoutMs`.
    const timedOut = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    try {
      return await Promise.race([entry.released.then(() => true), timedOut]);
    } finally {
      clearTimeout(timer);
    }
  }
}

function abortOnce(controller: AbortController, reason: DraftTurnStopReason): void {
  if (!controller.signal.aborted) controller.abort(reason);
}

/** The stop reason a lock's signal was aborted with (`operator` otherwise). */
export function draftTurnStopReason(signal: AbortSignal): DraftTurnStopReason {
  return signal.reason === 'timeout' ? 'timeout' : 'operator';
}
