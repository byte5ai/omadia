/**
 * Epic #470 W1 — image-cache warming loop tests (spec §4).
 *
 * These prove the WHEN and the WHAT-WE-REPORT the warmer wraps around the
 * engine's `warmImages`:
 *   - warms on boot and on the interval;
 *   - `/v1/health` state: warmed digests, `warm` flag, live surface;
 *   - `warm` is NEVER true until a pull has succeeded, and a later failure never
 *     un-warms or clobbers the last-good digests (a health endpoint must not lie);
 *   - concurrent warms JOIN one engine pull — no stampede, no stacking;
 *   - a pull failure is logged, recorded, retried next tick, and never rejects
 *     the loop (which would crash the daemon);
 *   - the interval timer is unref'd and stops on `stop()` (or this suite hangs and
 *     reports `# cancelled N`).
 *
 * The engine's `warmImages` (digest resolution via `repositoryOf`) is exercised in
 * `jobs.test.mjs`; here it is a controllable fake, so the warmer stores EXACTLY
 * the digests the engine resolved.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { createImageWarmer, DEFAULT_WARM_INTERVAL_MS } from '../src/warmer.mjs';

const REFS = ['ghcr.io/byte5ai/omadia-dev-runner:latest'];
const DIGEST = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

/** A promise plus its resolve/reject handles, for hand-driven pulls. */
function deferred() {
  /** @type {(v: string[]) => void} */
  let resolve;
  /** @type {(e: unknown) => void} */
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // @ts-expect-error assigned synchronously inside the executor
  return { promise, resolve, reject };
}

/**
 * A controllable warm-engine. `mode: 'resolved'` returns `digests` immediately;
 * `mode: 'deferred'` hands back a promise you settle by hand; `mode: 'reject'`
 * throws. `calls` counts every `warmImages` invocation.
 */
function fakeEngine(opts = {}) {
  const state = { mode: opts.mode ?? 'resolved', digests: opts.digests ?? [DIGEST], error: opts.error };
  const calls = { warm: 0, refs: /** @type {readonly string[][]} */ ([]) };
  /** @type {ReturnType<typeof deferred> | null} */
  let pending = null;
  return {
    calls,
    /** Settle the current deferred pull. */
    settle(digests = state.digests) {
      pending?.resolve(digests);
    },
    fail(err) {
      pending?.reject(err);
    },
    set(next) {
      Object.assign(state, next);
    },
    async warmImages(refs) {
      calls.warm += 1;
      calls.refs = [...calls.refs, [...refs]];
      if (state.mode === 'reject') throw state.error ?? new Error('pull failed');
      if (state.mode === 'deferred') {
        pending = deferred();
        return pending.promise;
      }
      return [...state.digests];
    },
  };
}

/** A logger that records warnings so we can assert a failure was logged. */
function fakeLogger() {
  const warns = [];
  return { warns, warn: (m) => warns.push(m), info: () => {} };
}

/** A fake `setInterval`/`clearInterval` pair that captures the tick callback and
 *  lets the test fire it by hand — so the loop is deterministic and never leaves a
 *  real timer running. `timer.unref` is a spy proving the loop unref'd it. */
function fakeTimers() {
  const captured = { cb: /** @type {(() => void) | null} */ (null), ms: 0, unrefCalls: 0, cleared: 0 };
  const timer = {
    unref() {
      captured.unrefCalls += 1;
      return timer;
    },
  };
  return {
    captured,
    tick() {
      captured.cb?.();
    },
    setInterval: /** @type {typeof setInterval} */ (
      /** @type {any} */ ((cb, ms) => {
        captured.cb = cb;
        captured.ms = Number(ms);
        return timer;
      })
    ),
    clearInterval: /** @type {typeof clearInterval} */ (
      /** @type {any} */ ((t) => {
        if (t === timer) captured.cleared += 1;
      })
    ),
  };
}

describe('dev-runner-daemon — image warmer', () => {
  it('starts empty and never warm before a pull succeeds', () => {
    const warmer = createImageWarmer({ engine: fakeEngine(), refs: REFS });
    const s = warmer.getState();
    assert.equal(s.warm, false);
    assert.deepEqual(s.digests, []);
    assert.equal(s.lastWarmedAt, null);
    assert.equal(s.lastError, null);
    assert.equal(warmer.isRunning(), false);
  });

  it('warms on boot: start() pulls once and records the resolved digests', async () => {
    const engine = fakeEngine({ digests: [DIGEST] });
    const timers = fakeTimers();
    const warmer = createImageWarmer({
      engine,
      refs: REFS,
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
    });
    warmer.start();
    // The boot pull is fire-and-forget; let it settle.
    await warmer.warm(); // joins the in-flight boot pull, does not start a second
    assert.equal(engine.calls.warm, 1, 'boot pull ran exactly once');
    assert.deepEqual(engine.calls.refs[0], REFS, 'pulled the configured refs');
    const s = warmer.getState();
    assert.equal(s.warm, true);
    assert.deepEqual(s.digests, [DIGEST]);
    assert.notEqual(s.lastWarmedAt, null);
    warmer.stop();
  });

  it('arms an unref\'d interval that stops on stop()', () => {
    const engine = fakeEngine();
    const timers = fakeTimers();
    const warmer = createImageWarmer({
      engine,
      refs: REFS,
      intervalMs: 12345,
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
    });
    warmer.start();
    assert.equal(timers.captured.ms, 12345, 'interval uses the configured period');
    assert.ok(timers.captured.unrefCalls >= 1, 'timer was unref\'d');
    assert.equal(warmer.isRunning(), true);
    warmer.stop();
    assert.equal(timers.captured.cleared, 1, 'stop() cleared the interval');
    assert.equal(warmer.isRunning(), false);
  });

  it('start() is idempotent — a second call does not arm a second loop', () => {
    const engine = fakeEngine();
    const timers = fakeTimers();
    const warmer = createImageWarmer({ engine, refs: REFS, setInterval: timers.setInterval, clearInterval: timers.clearInterval });
    warmer.start();
    warmer.start();
    // Boot pull ran once per start()? No — the second start() returns early.
    assert.equal(engine.calls.warm, 1, 'only the first start() booted a pull');
    warmer.stop();
  });

  it('defaults the interval to 6h', () => {
    const timers = fakeTimers();
    const warmer = createImageWarmer({ engine: fakeEngine(), refs: REFS, setInterval: timers.setInterval, clearInterval: timers.clearInterval });
    warmer.start();
    assert.equal(timers.captured.ms, DEFAULT_WARM_INTERVAL_MS);
    assert.equal(DEFAULT_WARM_INTERVAL_MS, 6 * 60 * 60 * 1000);
    warmer.stop();
  });

  it('a tick re-warms on the interval', async () => {
    const engine = fakeEngine({ digests: [DIGEST] });
    const timers = fakeTimers();
    const warmer = createImageWarmer({ engine, refs: REFS, setInterval: timers.setInterval, clearInterval: timers.clearInterval });
    warmer.start();
    await warmer.warm();
    assert.equal(engine.calls.warm, 1);
    timers.tick();
    await warmer.warm();
    assert.equal(engine.calls.warm, 2, 'the interval tick pulled again');
    warmer.stop();
  });

  it('concurrent warms JOIN one engine pull (no stampede)', async () => {
    const engine = fakeEngine({ mode: 'deferred', digests: [DIGEST] });
    const warmer = createImageWarmer({ engine, refs: REFS });
    const a = warmer.warm();
    const b = warmer.warm();
    assert.equal(engine.calls.warm, 1, 'two overlapping warms → one pull');
    engine.settle([DIGEST]);
    const [ra, rb] = await Promise.all([a, b]);
    assert.deepEqual(ra, [DIGEST]);
    assert.deepEqual(rb, [DIGEST]);
    // After the pull settles, a fresh warm starts a NEW pull.
    engine.set({ mode: 'resolved' });
    await warmer.warm();
    assert.equal(engine.calls.warm, 2);
  });

  it('a tick during a slow pull joins it rather than stacking', async () => {
    const engine = fakeEngine({ mode: 'deferred', digests: [DIGEST] });
    const timers = fakeTimers();
    const warmer = createImageWarmer({ engine, refs: REFS, setInterval: timers.setInterval, clearInterval: timers.clearInterval });
    warmer.start(); // boot pull is now in-flight (deferred)
    assert.equal(engine.calls.warm, 1);
    timers.tick(); // tick while the boot pull has not settled
    assert.equal(engine.calls.warm, 1, 'the tick joined the in-flight pull, no second pull');
    engine.settle([DIGEST]);
    await warmer.warm();
    warmer.stop();
  });

  it('a pull failure never marks warm, records the error, and is logged', async () => {
    const engine = fakeEngine({ mode: 'reject', error: new Error('registry unreachable') });
    const logger = fakeLogger();
    const warmer = createImageWarmer({ engine, refs: REFS, logger });
    await assert.rejects(() => warmer.warm(), /registry unreachable/);
    const s = warmer.getState();
    assert.equal(s.warm, false, 'a failed pull is never warm');
    assert.deepEqual(s.digests, []);
    assert.equal(s.lastWarmedAt, null);
    assert.match(s.lastError ?? '', /registry unreachable/);
    assert.equal(logger.warns.length, 1);
    assert.match(logger.warns[0], /image warm failed/);
  });

  it('retries on the next tick after a failure, and the loop never rejects', async () => {
    const engine = fakeEngine({ mode: 'reject', error: new Error('boom') });
    const logger = fakeLogger();
    const timers = fakeTimers();
    const warmer = createImageWarmer({
      engine,
      refs: REFS,
      logger,
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
    });
    warmer.start(); // boot pull fails — must NOT throw out of the loop
    // give the swallowed boot rejection a turn to settle
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(warmer.getState().warm, false);
    assert.ok(engine.calls.warm >= 1);
    // Registry recovers; the next tick succeeds and flips warm true.
    engine.set({ mode: 'resolved', digests: [DIGEST] });
    timers.tick();
    await warmer.warm();
    const s = warmer.getState();
    assert.equal(s.warm, true, 'the retry tick warmed successfully');
    assert.deepEqual(s.digests, [DIGEST]);
    assert.equal(s.lastError, null, 'a later success clears the error');
    warmer.stop();
  });

  it('a failure AFTER a success keeps the last-good digests and stays warm', async () => {
    const engine = fakeEngine({ mode: 'resolved', digests: [DIGEST] });
    const warmer = createImageWarmer({ engine, refs: REFS, logger: fakeLogger() });
    await warmer.warm();
    assert.equal(warmer.getState().warm, true);
    // Now the registry drops; the refresh fails.
    engine.set({ mode: 'reject', error: new Error('flaky') });
    await assert.rejects(() => warmer.warm());
    const s = warmer.getState();
    assert.equal(s.warm, true, 'a refresh failure does not un-warm cached images');
    assert.deepEqual(s.digests, [DIGEST], 'last-good digests are preserved');
    assert.match(s.lastError ?? '', /flaky/);
  });

  it('stores exactly the digests the engine resolved (multi-digest ref set)', async () => {
    const refs = ['ghcr.io/byte5ai/a:1', 'registry-1.docker.io/library/b:2'];
    const resolved = [`sha256:${'1'.repeat(64)}`, `sha256:${'2'.repeat(64)}`];
    const engine = fakeEngine({ digests: resolved });
    const warmer = createImageWarmer({ engine, refs });
    const out = await warmer.warm();
    assert.deepEqual(out, resolved);
    assert.deepEqual(warmer.getState().digests, resolved);
    assert.deepEqual(engine.calls.refs[0], refs);
  });

  it('a zero-digest pull succeeds but is not warm', async () => {
    const engine = fakeEngine({ digests: [] });
    const warmer = createImageWarmer({ engine, refs: [] });
    const out = await warmer.warm();
    assert.deepEqual(out, []);
    const s = warmer.getState();
    assert.equal(s.warm, false, 'nothing cached → not warm');
    assert.notEqual(s.lastWarmedAt, null, 'but the pull still counts as a successful warm');
  });

  it('getState() returns a copy — a caller cannot mutate the live state', async () => {
    const engine = fakeEngine({ digests: [DIGEST] });
    const warmer = createImageWarmer({ engine, refs: REFS });
    await warmer.warm();
    const s = warmer.getState();
    s.digests.push('sha256:tampered');
    s.warm = false;
    assert.deepEqual(warmer.getState().digests, [DIGEST], 'live digests untouched');
    assert.equal(warmer.getState().warm, true, 'live warm flag untouched');
  });

  it('lastWarmedAt reflects the injected clock', async () => {
    const engine = fakeEngine({ digests: [DIGEST] });
    const warmer = createImageWarmer({ engine, refs: REFS, clock: { now: () => 1_700_000_000_000 } });
    await warmer.warm();
    assert.equal(warmer.getState().lastWarmedAt, new Date(1_700_000_000_000).toISOString());
  });

  it('stop() is idempotent and safe before start()', () => {
    const warmer = createImageWarmer({ engine: fakeEngine(), refs: REFS });
    assert.doesNotThrow(() => warmer.stop());
    assert.doesNotThrow(() => warmer.stop());
    assert.equal(warmer.isRunning(), false);
  });
});
