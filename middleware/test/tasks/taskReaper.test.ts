import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  DEFAULT_TASK_PURGE_TERMINAL_AFTER_MS,
  DEFAULT_TASK_STALE_AFTER_MS,
  InMemoryTaskStore,
  runTaskReaperOnce,
  startTaskReaper,
  type TaskReapOptions,
  type TaskReapResult,
  type TaskStore,
} from '@omadia/orchestrator';

/**
 * #561 — the scheduled orphan sweep (`taskReaper.ts`), isolated from any store.
 *
 * This module owns only the SCHEDULE and the option-forwarding; the fencing that
 * makes the sweep safe across replicas lives in the store implementor and is
 * tested there, alongside that store's own reap and terminal-transition suites.
 * What this file pins:
 *
 *  - `runTaskReaperOnce` forwards the windows to `reapOrphans` — including the
 *    deliberate rule that `parkedStaleAfterMs` is passed ONLY when the operator
 *    set it (omitted ⇒ parked tasks are never force-failed).
 *  - `startTaskReaper` reports each sweep, survives a throwing sweep, and stops
 *    on dispose.
 *  - the cross-replica property at the store boundary: two independent sweeps
 *    over one store force-fail a stale task EXACTLY once — the terminal write is
 *    idempotent and so is the `staleFailed` metric.
 */

/** A store that records the options each `reapOrphans` was called with. */
function spyStore(): { store: TaskStore; calls: TaskReapOptions[] } {
  const calls: TaskReapOptions[] = [];
  const store = {
    reapOrphans: async (opts: TaskReapOptions): Promise<TaskReapResult> => {
      calls.push(opts);
      return { staleFailed: 0, purged: 0 };
    },
  } as unknown as TaskStore;
  return { store, calls };
}

describe('tasks/runTaskReaperOnce — option forwarding', () => {
  it('applies the documented default windows when none are given', async () => {
    const { store, calls } = spyStore();
    await runTaskReaperOnce(store);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.staleAfterMs, DEFAULT_TASK_STALE_AFTER_MS);
    assert.equal(calls[0]?.purgeTerminalAfterMs, DEFAULT_TASK_PURGE_TERMINAL_AFTER_MS);
    assert.equal(
      calls[0]?.parkedStaleAfterMs,
      undefined,
      'a parked window is NOT invented — parked tasks are never force-failed by default',
    );
  });

  it('forwards parkedStaleAfterMs only when the operator supplied it', async () => {
    const { store, calls } = spyStore();
    await runTaskReaperOnce(store, { parkedStaleAfterMs: 7_200_000 });
    assert.equal(calls[0]?.parkedStaleAfterMs, 7_200_000, 'the explicit parked window is passed through');
  });

  it('passes an injected clock straight to reapOrphans', async () => {
    const { store, calls } = spyStore();
    const now = new Date(1_700_000_000_000);
    await runTaskReaperOnce(store, {}, now);
    assert.equal(calls[0]?.now?.getTime(), now.getTime());
  });
});

describe('tasks/startTaskReaper — schedule lifecycle', () => {
  it('reports each sweep and stops sweeping once disposed', async () => {
    const { store, calls } = spyStore();
    const sweeps: TaskReapResult[] = [];
    const stop = startTaskReaper(store, { intervalMs: 1, onSweep: (r) => sweeps.push(r) });
    try {
      await new Promise((r) => setTimeout(r, 40));
      assert.ok(calls.length > 0, 'the reaper swept at least once');
      assert.equal(sweeps.length, calls.length, 'every sweep was reported to onSweep');
    } finally {
      stop();
    }
    const seen = calls.length;
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(calls.length, seen, 'no sweeps run after dispose');
  });

  it('routes a throwing sweep to onError instead of crashing the timer', async () => {
    let failures = 0;
    const store = {
      reapOrphans: async (): Promise<TaskReapResult> => {
        throw new Error('sweep boom');
      },
    } as unknown as TaskStore;

    const stop = startTaskReaper(store, { intervalMs: 1, onError: () => (failures += 1) });
    try {
      await new Promise((r) => setTimeout(r, 40));
      assert.ok(failures > 0, 'the sweep failure was surfaced to onError');
    } finally {
      stop();
    }
  });
});

describe('tasks/orphan sweep — #561 metric is idempotent across sweeps', () => {
  it('two independent sweeps over one store force-fail a stale task exactly once', async () => {
    // Two replicas would each schedule their own reaper against the same durable
    // store. Model that with two sweeps over one store: the first sees the stale
    // task and fails it; the second sees an already-terminal row and must NOT
    // re-fail (or re-count) it. Summing the two `staleFailed` proves once-only.
    let clock = 0;
    const store = new InMemoryTaskStore({ clock: () => clock });

    // A task nobody ever claims, then abandoned well past the stale window.
    await store.create({ kind: 'k', input: {} });
    clock = 10 * 60_000; // 10 min later — past a 1s stale window

    const opts = { staleAfterMs: 1_000, purgeTerminalAfterMs: 60 * 60_000, now: new Date(clock) };
    const first = await runTaskReaperOnce(store, opts, new Date(clock));
    const second = await runTaskReaperOnce(store, opts, new Date(clock));

    assert.equal(first.staleFailed, 1, 'the first sweep reaps the stale task');
    assert.equal(second.staleFailed, 0, 'the second sweep does not re-reap the same row');
    assert.equal(store.size(), 1, 'the row is still retained (terminal, not yet purged)');
  });
});
