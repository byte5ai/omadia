import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { ConductorEphemeralReaper } from '../src/conductor/ephemeralReaper.js';
import type { ConductorEphemeralStore, ReapableWorkflow } from '../src/conductor/ephemeralStore.js';

// #330 — reaper semantics: TTL-expired rows get a cancel request for their
// active runs, every reapable row is soft-reaped (disable + reaped_at), and a
// physical delete is only ever attempted through the guarded store method.
// Fakes throughout, per-row error isolation verified explicitly.

interface Calls {
  cancelled: Array<{ id: string; by: string }>;
  reaped: string[];
  hardDeleted: string[];
}

function fakeStore(opts: {
  reapable: ReapableWorkflow[];
  listError?: Error;
  reapErrorFor?: string;
}): { store: ConductorEphemeralStore; calls: Calls } {
  const calls: Calls = { cancelled: [], reaped: [], hardDeleted: [] };
  const store = {
    listReapable: async () => {
      if (opts.listError) throw opts.listError;
      return opts.reapable;
    },
    requestCancelActiveRuns: async (id: string, by: string) => {
      calls.cancelled.push({ id, by });
      return 1;
    },
    markReaped: async (id: string) => {
      if (opts.reapErrorFor === id) throw new Error(`reap of ${id} failed`);
      calls.reaped.push(id);
    },
    hardDeleteUnreferenced: async (id: string) => {
      calls.hardDeleted.push(id);
      return false;
    },
  } as unknown as ConductorEphemeralStore;
  return { store, calls };
}

describe('ConductorEphemeralReaper.tick', () => {
  it('cancels active runs of an expired workflow, then soft-reaps it', async () => {
    const { store, calls } = fakeStore({ reapable: [{ id: 'wf-1', slug: 'eph-a', expired: true }] });
    await new ConductorEphemeralReaper({ store }).tick();

    assert.deepEqual(calls.cancelled, [{ id: 'wf-1', by: 'conductor-ephemeral-reaper' }]);
    assert.deepEqual(calls.reaped, ['wf-1']);
    assert.deepEqual(calls.hardDeleted, ['wf-1']);
  });

  it('reaps a terminal (non-expired) workflow without any cancel request, retaining run history', async () => {
    const { store, calls } = fakeStore({ reapable: [{ id: 'wf-2', slug: 'eph-b', expired: false }] });
    await new ConductorEphemeralReaper({ store }).tick();

    assert.deepEqual(calls.cancelled, []);
    assert.deepEqual(calls.reaped, ['wf-2']);
    // The delete is the GUARDED store method — the fake reports 'row referenced,
    // not deleted', i.e. the definition is retained as audit trace. No other
    // deletion path exists in the reaper.
    assert.deepEqual(calls.hardDeleted, ['wf-2']);
  });

  it('isolates a failing row — later rows are still reaped', async () => {
    const { store, calls } = fakeStore({
      reapable: [
        { id: 'wf-bad', slug: 'eph-bad', expired: false },
        { id: 'wf-good', slug: 'eph-good', expired: false },
      ],
      reapErrorFor: 'wf-bad',
    });
    const logs: string[] = [];
    await new ConductorEphemeralReaper({ store, log: (m) => logs.push(m) }).tick();

    assert.deepEqual(calls.reaped, ['wf-good']);
    assert.ok(logs.some((l) => l.includes("reap of 'eph-bad' failed")));
  });

  it('#330 C2a — onReaped runs BEFORE the soft-reap; its failure never blocks the reap', async () => {
    const { store, calls } = fakeStore({ reapable: [{ id: 'wf-1', slug: 'eph-a', expired: false }] });
    const order: string[] = [];
    const origMarkReaped = store.markReaped.bind(store);
    (store as { markReaped: (id: string) => Promise<void> }).markReaped = async (id: string) => {
      order.push('markReaped');
      await origMarkReaped(id);
    };
    await new ConductorEphemeralReaper({
      store,
      onReaped: async (wf) => {
        order.push(`onReaped:${wf.slug}`);
      },
    }).tick();
    assert.deepEqual(order, ['onReaped:eph-a', 'markReaped']);
    assert.deepEqual(calls.reaped, ['wf-1']);

    const failing = fakeStore({ reapable: [{ id: 'wf-2', slug: 'eph-b', expired: false }] });
    const logs: string[] = [];
    await new ConductorEphemeralReaper({
      store: failing.store,
      onReaped: async () => {
        throw new Error('cleanup down');
      },
      log: (m) => logs.push(m),
    }).tick();
    assert.deepEqual(failing.calls.reaped, ['wf-2'], 'reap must proceed despite cleanup failure');
    assert.ok(logs.some((l) => l.includes('attachment cleanup')));
  });

  it('survives a listReapable failure without throwing', async () => {
    const { store, calls } = fakeStore({ reapable: [], listError: new Error('db down') });
    const logs: string[] = [];
    await new ConductorEphemeralReaper({ store, log: (m) => logs.push(m) }).tick();

    assert.deepEqual(calls.reaped, []);
    assert.ok(logs.some((l) => l.includes('reaper list failed')));
  });
});
