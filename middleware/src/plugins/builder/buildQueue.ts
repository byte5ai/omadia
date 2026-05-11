import type { BuildResult, BuildFailure } from './buildSandbox.js';

/**
 * BuildQueue — global FIFO queue with concurrency cap and per-draft
 * coalescing for the builder pipeline.
 *
 * Semantics:
 *   - **Concurrency cap** (default 3): never more than `concurrency` builds
 *     running at once; the rest wait FIFO.
 *   - **Coalescing**: a fresh `enqueue(draftId, …)` for a draft id that is
 *     already queued or running aborts the prior entry (`AbortController.abort`)
 *     and takes its slot. The displaced entry's promise resolves with a
 *     BuildFailure of reason `'abort'`. Build functions are expected to
 *     observe the signal — buildSandbox does (its `executeBuild` is
 *     abort-aware).
 *   - **State callbacks**: optional `onStateChange(draftId, phase, queuePos?)`
 *     fires for `'queued' | 'building' | 'ok' | 'failed' | 'aborted'`. Used
 *     by the SSE bridge in B.3/B.5 to surface progress to the workspace UI.
 *   - **Graceful drain**: `drain(timeoutMs)` rejects all waiters, lets
 *     running builds finish up to the timeout, then force-aborts. Hook into
 *     `SIGTERM` / Fly machine stop.
 */

export type BuildPhase = 'queued' | 'building' | 'ok' | 'failed' | 'aborted';

export type QueueBuildFn = (signal: AbortSignal) => Promise<BuildResult>;

export interface BuildQueueOptions {
  concurrency?: number;
  onStateChange?: (draftId: string, phase: BuildPhase, queuePos?: number) => void;
}

export interface DrainResult {
  drained: boolean;
  remainingRunning: number;
}

interface BaseEntry {
  draftId: string;
  buildFn: QueueBuildFn;
  resolve: (r: BuildResult) => void;
  abortCtrl: AbortController;
}

interface QueuedEntry extends BaseEntry {
  state: 'queued';
}

interface RunningEntry extends BaseEntry {
  state: 'running';
  startedAt: number;
}

type Entry = QueuedEntry | RunningEntry;

const DEFAULT_CONCURRENCY = 3;
const DEFAULT_DRAIN_TIMEOUT_MS = 15_000;

function abortFailure(): BuildFailure {
  return {
    ok: false,
    errors: [],
    exitCode: null,
    stdoutTail: '',
    stderrTail: '',
    durationMs: 0,
    reason: 'abort',
  };
}

export class BuildQueue {
  private readonly waiting: QueuedEntry[] = [];
  private readonly running = new Map<string, RunningEntry>();
  /** Either-or index: a draftId points to its waiting OR running entry. */
  private readonly byDraft = new Map<string, Entry>();
  private readonly concurrency: number;
  private readonly onStateChange?: BuildQueueOptions['onStateChange'];
  private draining = false;

  constructor(opts: BuildQueueOptions = {}) {
    this.concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY;
    this.onStateChange = opts.onStateChange;
  }

  enqueue(draftId: string, buildFn: QueueBuildFn): Promise<BuildResult> {
    if (this.draining) {
      return Promise.resolve(abortFailure());
    }

    return new Promise<BuildResult>((resolve) => {
      const abortCtrl = new AbortController();

      // Coalesce against any existing entry for this draftId.
      const existing = this.byDraft.get(draftId);
      if (existing) {
        existing.abortCtrl.abort();
        if (existing.state === 'queued') {
          // Pull the waiter out of the queue and settle its promise as
          // aborted — its build function never ran.
          const idx = this.waiting.indexOf(existing);
          if (idx >= 0) this.waiting.splice(idx, 1);
          existing.resolve(abortFailure());
        }
        // Running entries: leave them in place. Their `runEntry` will see
        // `signal.aborted` and resolve through the abort path. We do NOT
        // hold up the new enqueue waiting for that.
      }

      const queued: QueuedEntry = {
        draftId,
        buildFn,
        resolve,
        abortCtrl,
        state: 'queued',
      };
      this.byDraft.set(draftId, queued);
      this.waiting.push(queued);

      this.notifyState(draftId, 'queued', this.computeQueuePos(queued));
      this.tryRunNext();
    });
  }

  private computeQueuePos(entry: QueuedEntry): number {
    return this.waiting.indexOf(entry);
  }

  private tryRunNext(): void {
    while (this.running.size < this.concurrency && this.waiting.length > 0) {
      const next = this.waiting.shift()!;
      const running: RunningEntry = {
        draftId: next.draftId,
        buildFn: next.buildFn,
        resolve: next.resolve,
        abortCtrl: next.abortCtrl,
        state: 'running',
        startedAt: Date.now(),
      };
      this.running.set(next.draftId, running);
      // byDraft was pointing at the queued entry — overwrite with running.
      // (If a coalesce happened in the meantime, byDraft already points at
      // the newer queued entry; in that case `next` is the displaced one
      // whose promise was already settled, but we still drained it from
      // `waiting` above, so this is just defensive.)
      if (this.byDraft.get(next.draftId) === next) {
        this.byDraft.set(next.draftId, running);
      }
      this.notifyState(next.draftId, 'building');
      void this.runEntry(running);
    }
    // Refresh queue positions for remaining waiters.
    for (let i = 0; i < this.waiting.length; i++) {
      const w = this.waiting[i]!;
      this.notifyState(w.draftId, 'queued', i);
    }
  }

  private async runEntry(entry: RunningEntry): Promise<void> {
    let result: BuildResult;
    try {
      result = await entry.buildFn(entry.abortCtrl.signal);
    } catch (err) {
      result = {
        ok: false,
        errors: [],
        exitCode: null,
        stdoutTail: '',
        stderrTail: (err as Error).message,
        durationMs: Date.now() - entry.startedAt,
        reason: 'unknown',
      };
    }

    if (entry.abortCtrl.signal.aborted && result.ok === false && result.reason !== 'abort') {
      result = { ...result, reason: 'abort' };
    }

    this.running.delete(entry.draftId);
    if (this.byDraft.get(entry.draftId) === entry) {
      this.byDraft.delete(entry.draftId);
    }

    entry.resolve(result);

    const phase: BuildPhase = result.ok
      ? 'ok'
      : result.reason === 'abort'
        ? 'aborted'
        : 'failed';
    this.notifyState(entry.draftId, phase);

    this.tryRunNext();
  }

  private notifyState(draftId: string, phase: BuildPhase, queuePos?: number): void {
    if (!this.onStateChange) return;
    try {
      this.onStateChange(draftId, phase, queuePos);
    } catch {
      // Callbacks must not break the queue.
    }
  }

  /**
   * Wait for in-flight builds to settle (up to `timeoutMs`), reject all
   * waiters immediately, then force-abort anything still running.
   */
  async drain(timeoutMs: number = DEFAULT_DRAIN_TIMEOUT_MS): Promise<DrainResult> {
    this.draining = true;

    // Settle all waiters as aborted.
    for (const w of this.waiting) {
      w.resolve(abortFailure());
      if (this.byDraft.get(w.draftId) === w) {
        this.byDraft.delete(w.draftId);
      }
    }
    this.waiting.length = 0;

    if (this.running.size === 0) {
      return { drained: true, remainingRunning: 0 };
    }

    const deadline = Date.now() + timeoutMs;
    while (this.running.size > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }

    if (this.running.size > 0) {
      for (const r of this.running.values()) {
        r.abortCtrl.abort();
      }
      // Give the abort one more tick to propagate.
      const graceDeadline = Date.now() + 200;
      while (this.running.size > 0 && Date.now() < graceDeadline) {
        await new Promise((r) => setTimeout(r, 25));
      }
    }

    return { drained: this.running.size === 0, remainingRunning: this.running.size };
  }

  // --- introspection -----------------------------------------------------

  get queuedSize(): number {
    return this.waiting.length;
  }

  get runningSize(): number {
    return this.running.size;
  }

  get size(): number {
    return this.waiting.length + this.running.size;
  }
}
