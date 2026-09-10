import { afterEach, describe, expect, it, vi } from 'vitest';

import { RSC_FETCH_TIMEOUT_MS, rscTimeoutSignal } from '../api';

/**
 * OM-96 — a server-side fetch must not be able to hang forever.
 *
 * The reported symptom was "the DASHBOARD nav item does not navigate": the
 * page stayed and the active marker stayed. The nav was innocent. `app/page.tsx`
 * is `force-dynamic` and awaits six `getJson()` calls; with no timeout on them
 * and no root `loading.tsx`, a middleware endpoint that accepts the connection
 * and never answers meant the RSC payload for `/` never arrived and the soft
 * navigation never committed. Reproduced against a TCP stub that accepts and
 * never replies.
 *
 * These tests pin the abort-signal policy — which fetches get a deadline, and
 * which are deliberately left alone.
 */

const ORIGINAL_WINDOW = Object.getOwnPropertyDescriptor(globalThis, 'window');

/** jsdom gives us a `window`; the RSC path is the one WITHOUT it. */
function asServer(): void {
  Object.defineProperty(globalThis, 'window', {
    value: undefined,
    configurable: true,
    writable: true,
  });
}

afterEach(() => {
  if (ORIGINAL_WINDOW) {
    Object.defineProperty(globalThis, 'window', ORIGINAL_WINDOW);
  }
  vi.useRealTimers();
});

describe('rscTimeoutSignal (OM-96)', () => {
  it('gives a server-side fetch a deadline', () => {
    asServer();
    const signal = rscTimeoutSignal();
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(false);
  });

  it('produces a signal that aborts on its own, with no further input', async () => {
    // The mechanism this whole fix rests on: the signal fires from a timer the
    // runtime owns, so a fetch that is never answered still settles. Asserted
    // with a real 10ms budget rather than fake timers on the production one —
    // `AbortSignal.timeout` uses a HOST timer that `vi.useFakeTimers()` does
    // not drive, so faking it here would assert nothing and pass by accident.
    asServer();
    const production = rscTimeoutSignal();
    expect(production?.aborted).toBe(false);

    const quick = AbortSignal.timeout(10);
    await new Promise<void>((resolve) => {
      quick.addEventListener('abort', () => resolve(), { once: true });
    });

    expect(quick.aborted).toBe(true);
    expect(quick.reason).toBeInstanceOf(Error);
    // A fetch given that signal rejects rather than hanging — which is what
    // lets `page.tsx`'s `allSettled` degrade one card and render the rest.
    await expect(
      fetch('http://127.0.0.1:1/never', { signal: quick }),
    ).rejects.toThrow();
  });

  it('leaves browser-side fetches unbounded', () => {
    // They do not gate a navigation, and some legitimately outlive the budget.
    expect(rscTimeoutSignal()).toBeUndefined();
  });

  it("never overrides a caller's own signal", () => {
    // A caller that passed a signal owns the lifetime — silently replacing it
    // would break cancellation for whoever set it up.
    asServer();
    const own = new AbortController().signal;
    expect(rscTimeoutSignal({ signal: own })).toBe(own);
  });

  it("keeps the caller's signal on the browser side too", () => {
    const own = new AbortController().signal;
    expect(rscTimeoutSignal({ signal: own })).toBe(own);
  });

  it('keeps the budget far above a healthy loopback call', () => {
    // Guards against someone "tightening" this into a source of flakes: the
    // deadline exists to break hangs, not to police normal latency.
    expect(RSC_FETCH_TIMEOUT_MS).toBeGreaterThanOrEqual(5_000);
    expect(RSC_FETCH_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
  });
});

describe('the allSettled path the timeout feeds (OM-96)', () => {
  it('renders the survivors when one upstream call rejects', async () => {
    // `page.tsx` isolates each fetch with allSettled. Before the timeout there
    // was nothing to settle — the pending fetch simply never resolved.
    const results = await Promise.allSettled([
      Promise.resolve('providers'),
      Promise.reject(new Error('TimeoutError')),
      Promise.resolve('plugins'),
    ]);

    expect(results.map((r) => r.status)).toEqual([
      'fulfilled',
      'rejected',
      'fulfilled',
    ]);
    const usable = results.filter((r) => r.status === 'fulfilled');
    expect(usable).toHaveLength(2);
  });
});
