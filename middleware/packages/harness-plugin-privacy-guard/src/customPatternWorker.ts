/**
 * #1553 — operator deny-list regexes run OFF the main thread.
 *
 * JS RegExp is not RE2: a pattern can backtrack for seconds or minutes on the
 * right input, and while it does the event loop of the whole middleware is
 * blocked — every other user's turn and `/health` wait with it. Measuring the
 * time after the match (the old runtime "budget") cannot help: the damage is
 * done by then.
 *
 * So the patterns run in a `node:worker_threads` Worker, and the main thread
 * enforces the budget with a timer. On timeout the worker is terminated
 * (V8 interrupts a running regex), every request it still held is rejected,
 * and the next call spawns a fresh one. The caller turns a rejection into a
 * blocked turn — fail-closed, never an unmasked pass-through.
 *
 *   - one worker per detector (= per deny-list config), spawned lazily,
 *     reused across calls with request ids, and terminated after a minute
 *     idle, so a replaced config leaves no thread behind;
 *   - the worker is `unref()`ed: it never keeps the process alive. A pending
 *     request's budget timer does, but only until the budget runs out;
 *   - the budget timer starts once the worker is online; spawning has its
 *     own, generous timeout (a cold worker under load may take a while), and
 *     a worker that does not come up fails closed too.
 *
 * Which pattern was running when the budget ran out is read from a small
 * shared progress buffer the worker updates before every pattern, so the
 * log names the culprit — and a request that finished just as its timer
 * fired is not mistaken for an overrun. A request queued behind another one
 * does not spend its budget waiting; when a runaway match is stopped, only
 * that request fails and the queued ones move to a fresh worker.
 */

import { Worker } from 'node:worker_threads';

/** How long a fresh worker may take to come online. */
const WORKER_STARTUP_TIMEOUT_MS = 10_000;
/** An idle worker is terminated after this long; the next call respawns. */
const WORKER_IDLE_MS = 60_000;

/** Progress slots in the shared buffer. */
const RUNNING_REQUEST = 0;
const RUNNING_PATTERN = 1;
const FINISHED_REQUEST = 2;

/** The worker: compiles each pattern once, matches, reports spans and its
 *  own per-pattern time. Plain CommonJS — `eval: true` workers are scripts. */
const WORKER_SOURCE = `
'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const progress = new Int32Array(workerData.progress);
const compiled = new Map();
parentPort.on('message', ({ id, patterns, text }) => {
  try {
    Atomics.store(progress, ${String(RUNNING_REQUEST)}, id);
    const results = patterns.map(({ source, flags }, index) => {
      Atomics.store(progress, ${String(RUNNING_PATTERN)}, index);
      const key = flags + '/' + source;
      let re = compiled.get(key);
      if (re === undefined) {
        re = new RegExp(source, flags);
        compiled.set(key, re);
      }
      re.lastIndex = 0;
      const startedAt = performance.now();
      const spans = [];
      for (const match of text.matchAll(re)) {
        if (match[0].length === 0) continue;
        spans.push([match.index, match.index + match[0].length]);
      }
      return { spans, elapsedMs: performance.now() - startedAt };
    });
    Atomics.store(progress, ${String(FINISHED_REQUEST)}, id);
    parentPort.postMessage({ id, results });
  } catch (err) {
    Atomics.store(progress, ${String(FINISHED_REQUEST)}, id);
    parentPort.postMessage({ id, error: String((err && err.message) || err) });
  }
});
`;

export interface WorkerPattern {
  readonly source: string;
  readonly flags: string;
}

export interface PatternResult {
  /** `[start, end)` of every non-empty match, in text order. */
  readonly spans: ReadonlyArray<readonly [number, number]>;
  /** Time the worker spent on this pattern. */
  readonly elapsedMs: number;
}

/** The match ran out of its budget and the worker was terminated. */
export class PatternBudgetExceeded extends Error {
  constructor(
    /** The pattern that was running, when known. */
    public readonly culprit: string | undefined,
    public readonly elapsedMs: number,
  ) {
    super(`custom pattern match exceeded its budget (${String(Math.round(elapsedMs))}ms)`);
    this.name = 'PatternBudgetExceeded';
  }
}

interface Pending {
  readonly patterns: readonly WorkerPattern[];
  readonly text: string;
  readonly budgetMs: number;
  readonly resolve: (results: readonly PatternResult[]) => void;
  readonly reject: (err: Error) => void;
  timer?: NodeJS.Timeout;
  /** When the worker started on this request; unset while it is queued. */
  startedAt?: number;
}

interface Live {
  readonly worker: Worker;
  readonly online: Promise<void>;
  readonly progress: Int32Array;
}

type WorkerReply =
  | { readonly id: number; readonly results: readonly PatternResult[] }
  | { readonly id: number; readonly error: string };

/**
 * A lazily spawned regex worker. `match` resolves with one result per
 * pattern, or rejects — `PatternBudgetExceeded` on a timeout, a plain error
 * when the worker failed to start or died.
 */
export class CustomPatternWorker {
  private live: Live | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private idleTimer: NodeJS.Timeout | undefined;

  async match(
    patterns: readonly WorkerPattern[],
    text: string,
    budgetMs: number,
  ): Promise<readonly PatternResult[]> {
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    const live = this.spawn();
    await live.online;
    const id = this.nextId++;
    return new Promise<readonly PatternResult[]>((resolve, reject) => {
      const entry: Pending = { patterns, text, budgetMs, resolve, reject };
      this.pending.set(id, entry);
      this.post(live, id, entry);
    });
  }

  /** Hand `entry` to `live` and arm its budget timer. */
  private post(live: Live, id: number, entry: Pending): void {
    // Posted to an idle worker, it starts now; behind others, its clock
    // starts when `onBudget` sees the worker on it (at most one extra window).
    entry.startedAt = this.pending.size <= 1 ? Date.now() : undefined;
    entry.timer = setTimeout(() => this.onBudget(live, id), Math.max(0, entry.budgetMs));
    live.worker.postMessage({ id, patterns: entry.patterns, text: entry.text });
  }

  /** Terminate the worker and reject everything it still holds. */
  dispose(reason: Error = new Error('[privacy-guard v4] custom pattern worker disposed')): void {
    const live = this.live;
    this.live = undefined;
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    for (const [id, entry] of this.pending) {
      if (entry.timer !== undefined) clearTimeout(entry.timer);
      this.pending.delete(id);
      entry.reject(reason);
    }
    if (live !== undefined) void live.worker.terminate().catch(() => undefined);
  }

  private spawn(): Live {
    if (this.live !== undefined) return this.live;
    const shared = new SharedArrayBuffer(3 * Int32Array.BYTES_PER_ELEMENT);
    const worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { progress: shared } });
    const online = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`[privacy-guard v4] custom pattern worker did not start within ${String(WORKER_STARTUP_TIMEOUT_MS)}ms`));
      }, WORKER_STARTUP_TIMEOUT_MS);
      worker.once('online', () => {
        clearTimeout(timer);
        resolve();
      });
      worker.once('error', (err: Error) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    const live: Live = { worker, online, progress: new Int32Array(shared) };
    this.live = live;
    // A worker that never comes up is dropped, so the next call respawns.
    online.catch((err: unknown) => {
      if (this.live === live) this.dispose(err instanceof Error ? err : new Error(String(err)));
    });
    worker.on('message', (reply: WorkerReply) => this.onReply(reply));
    worker.on('error', (err: Error) => {
      if (this.live === live) this.dispose(err);
    });
    worker.on('exit', () => {
      if (this.live === live) this.dispose(new Error('[privacy-guard v4] custom pattern worker exited'));
    });
    // After the listeners: attaching a 'message' listener refs the worker
    // again.
    worker.unref();
    return live;
  }

  private onReply(reply: WorkerReply): void {
    const entry = this.pending.get(reply.id);
    if (entry === undefined) return;
    this.pending.delete(reply.id);
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    if ('error' in reply) entry.reject(new Error(`[privacy-guard v4] custom pattern failed: ${reply.error}`));
    else entry.resolve(reply.results);
    this.scheduleIdle();
  }

  private onBudget(live: Live, id: number): void {
    const entry = this.pending.get(id);
    if (this.live !== live || entry === undefined) return;
    // Finished just as the timer fired: the reply is on its way.
    if (Atomics.load(live.progress, FINISHED_REQUEST) >= id) return;
    const runningId = Atomics.load(live.progress, RUNNING_REQUEST);
    if (runningId < id) {
      // Still queued behind another request: its own budget starts when the
      // worker picks it up. The running request's timer stops a runaway.
      entry.timer = setTimeout(() => this.onBudget(live, id), Math.max(1, entry.budgetMs));
      return;
    }
    if (entry.startedAt === undefined) {
      // Picked up during this budget window: give it a full budget of its own.
      entry.startedAt = Date.now();
      entry.timer = setTimeout(() => this.onBudget(live, id), Math.max(0, entry.budgetMs));
      return;
    }
    // It ran a whole budget: stop it. Only THIS request fails (the caller
    // blocks its turn); requests queued behind it go to a fresh worker.
    const culprit = entry.patterns[Atomics.load(live.progress, RUNNING_PATTERN)]?.source;
    this.pending.delete(id);
    const queued = [...this.pending.entries()];
    this.pending.clear();
    this.dispose();
    entry.reject(new PatternBudgetExceeded(culprit, Date.now() - entry.startedAt));
    if (queued.length === 0) return;
    const fresh = this.spawn();
    for (const [queuedId, queuedEntry] of queued) {
      if (queuedEntry.timer !== undefined) clearTimeout(queuedEntry.timer);
      this.pending.set(queuedId, queuedEntry);
    }
    fresh.online.then(
      () => {
        for (const [queuedId, queuedEntry] of queued) {
          if (this.live === fresh && this.pending.get(queuedId) === queuedEntry) {
            this.post(fresh, queuedId, queuedEntry);
          }
        }
      },
      () => undefined, // a worker that does not come up rejects them (spawn)
    );
  }

  private scheduleIdle(): void {
    if (this.pending.size > 0 || this.live === undefined) return;
    this.idleTimer = setTimeout(() => this.dispose(), WORKER_IDLE_MS);
    this.idleTimer.unref();
  }
}
