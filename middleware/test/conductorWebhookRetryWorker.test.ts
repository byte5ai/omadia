import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { ConductorWebhookRetryWorker } from '../src/conductor/webhookRetryWorker.js';
import type { ConductorWebhookDispatcher } from '../src/conductor/webhookDispatcher.js';
import type { ConductorWebhookSubscriptionStore, ConductorWebhookDelivery } from '../src/conductor/webhookSubscriptionStore.js';

// Issue #437 review finding: the retry worker's tick/reconcile-before-claimDue
// ordering was untested. This asserts (1) reconcile always runs before claimDue on
// every tick, and (2) a reconcile pass that finds a terminal run with no delivery
// row creates one — modeled on index.ts's `reconcileMissingWebhookDeliveries`
// (listMissingRunDeliveries → createDelivery for each gap), so the SAME shape of
// effect the real wiring produces is what's asserted here.

function delivery(id: string, subscriptionId: string): ConductorWebhookDelivery {
  return {
    id,
    subscriptionId,
    event: 'run.completed',
    payload: {},
    status: 'pending',
    attempts: 0,
    lastError: null,
    nextAttemptAt: new Date(0),
    deliveredAt: null,
    createdAt: new Date(0),
  };
}

describe('ConductorWebhookRetryWorker.tick — reconcile-before-claimDue ordering', () => {
  it('runs reconcile to completion before calling claimDue, on every tick', async () => {
    const order: string[] = [];
    const store = {
      claimDue: async () => {
        order.push('claimDue');
        return [];
      },
      get: async () => null,
      recordFailure: async () => undefined,
    } as unknown as ConductorWebhookSubscriptionStore;
    const dispatcher = { attempt: async () => undefined } as unknown as ConductorWebhookDispatcher;
    const reconcile = async (): Promise<void> => {
      order.push('reconcile-start');
      await new Promise((r) => setTimeout(r, 5)); // force a real async gap
      order.push('reconcile-end');
    };

    const worker = new ConductorWebhookRetryWorker({ store, dispatcher, reconcile });
    await worker.tick();
    await worker.tick();

    assert.deepEqual(order, [
      'reconcile-start', 'reconcile-end', 'claimDue',
      'reconcile-start', 'reconcile-end', 'claimDue',
    ]);
  });

  it('a reconcile pass that finds a terminal run with no delivery row creates one, and it is claimed on the SAME tick', async () => {
    // Models index.ts's reconcileMissingWebhookDeliveries: listMissingRunDeliveries → createDelivery
    // for every gap found, using a fake store whose claimDue only returns rows created THIS tick.
    const createdDeliveries: Array<{ subscriptionId: string; event: string; runId: string }> = [];
    const missingByRun = new Map<string, { runId: string; status: 'completed' | 'failed'; subscriptionId: string }>([
      ['run-orphaned', { runId: 'run-orphaned', status: 'completed', subscriptionId: 'sub-1' }],
    ]);
    let claimed: ConductorWebhookDelivery[] = [];

    const store = {
      listMissingRunDeliveries: async () => [...missingByRun.values()],
      createDelivery: async (input: { subscriptionId: string; event: string; payload: { runId?: unknown } }) => {
        createdDeliveries.push({ subscriptionId: input.subscriptionId, event: input.event, runId: String(input.payload.runId) });
        missingByRun.delete(String(input.payload.runId)); // no longer "missing" once created
        const row = delivery(`d-${input.subscriptionId}`, input.subscriptionId);
        claimed = [row]; // becomes claimable by claimDue in this same tick
        return row;
      },
      claimDue: async () => {
        const due = claimed;
        claimed = [];
        return due;
      },
      get: async () => ({ id: 'sub-1', url: 'https://example.com/hook', event: 'run.completed', description: null, enabled: true, createdBy: 'x', createdAt: new Date() }),
      recordFailure: async () => undefined,
    } as unknown as ConductorWebhookSubscriptionStore;

    const attempted: ConductorWebhookDelivery[] = [];
    const dispatcher = {
      attempt: async (d: ConductorWebhookDelivery) => {
        attempted.push(d);
      },
    } as unknown as ConductorWebhookDispatcher;

    const reconcile = async (): Promise<void> => {
      for (const m of await store.listMissingRunDeliveries('irrelevant')) {
        await store.createDelivery({ subscriptionId: m.subscriptionId, event: `run.${m.status}`, payload: { runId: m.runId } });
      }
    };

    const worker = new ConductorWebhookRetryWorker({ store, dispatcher, reconcile });
    await worker.tick();

    assert.deepEqual(createdDeliveries, [{ subscriptionId: 'sub-1', event: 'run.completed', runId: 'run-orphaned' }]);
    assert.equal(attempted.length, 1, 'the just-created delivery must be picked up by claimDue in the SAME tick (reconcile runs before it)');
    assert.equal(attempted[0]!.id, 'd-sub-1');

    // A second tick finds nothing left to reconcile and nothing new to claim.
    await worker.tick();
    assert.equal(attempted.length, 1);
  });

  it('a reconcile failure is logged and does not prevent claimDue from still running', async () => {
    const logs: string[] = [];
    let claimDueCalled = false;
    const store = {
      claimDue: async () => {
        claimDueCalled = true;
        return [];
      },
    } as unknown as ConductorWebhookSubscriptionStore;
    const dispatcher = {} as unknown as ConductorWebhookDispatcher;
    const worker = new ConductorWebhookRetryWorker({
      store,
      dispatcher,
      reconcile: async () => {
        throw new Error('reconcile blew up');
      },
      log: (msg) => logs.push(msg),
    });

    await worker.tick();

    assert.ok(claimDueCalled, 'claimDue must still run even if reconcile throws');
    assert.ok(logs.some((l) => l.includes('reconciliation pass failed')), JSON.stringify(logs));
  });
  // --- #1704: the retry path drives attempts 2..N, so it has to be diagnosable too.

  it('logs the terminal "subscription no longer exists" outcome instead of recording it silently', async () => {
    const logs: string[] = [];
    const failures: Array<{ id: string; error: string; nextAttemptAt: Date | null }> = [];
    const store = {
      claimDue: async () => [delivery('d-1', 'sub-gone')],
      get: async () => null, // the subscription was deleted under the pending delivery
      recordFailure: async (id: string, error: string, nextAttemptAt: Date | null) => {
        failures.push({ id, error, nextAttemptAt });
      },
    } as unknown as ConductorWebhookSubscriptionStore;
    const dispatcher = { attempt: async () => undefined } as unknown as ConductorWebhookDispatcher;

    const worker = new ConductorWebhookRetryWorker({ store, dispatcher, log: (msg) => logs.push(msg) });
    await worker.tick();

    assert.equal(failures.length, 1);
    assert.equal(failures[0]?.nextAttemptAt, null); // terminal — nothing will ever retry it
    // The dispatcher never sees this row, so without a line here the delivery dies unlogged.
    assert.equal(logs.length, 1, JSON.stringify(logs));
    assert.match(logs[0] ?? '', /d-1/);
    assert.match(logs[0] ?? '', /sub-gone/);
    assert.match(logs[0] ?? '', /subscription no longer exists/);
  });

  it('names the undici cause in its own log lines, not a bare "fetch failed"', async () => {
    const logs: string[] = [];
    const transportError = new TypeError('fetch failed', {
      cause: Object.assign(new Error('getaddrinfo ENOTFOUND doesnotexist.invalid'), { code: 'ENOTFOUND' }),
    });

    // (1) the claimDue path
    const claimFails = {
      claimDue: async () => {
        throw transportError;
      },
    } as unknown as ConductorWebhookSubscriptionStore;
    const w1 = new ConductorWebhookRetryWorker({
      store: claimFails,
      dispatcher: {} as unknown as ConductorWebhookDispatcher,
      log: (msg) => logs.push(msg),
    });
    await w1.tick();

    // (2) the reconcile path
    const w2 = new ConductorWebhookRetryWorker({
      store: { claimDue: async () => [] } as unknown as ConductorWebhookSubscriptionStore,
      dispatcher: {} as unknown as ConductorWebhookDispatcher,
      reconcile: async () => {
        throw transportError;
      },
      log: (msg) => logs.push(msg),
    });
    await w2.tick();

    // (3) the attempt-crashed path
    const w3 = new ConductorWebhookRetryWorker({
      store: {
        claimDue: async () => [delivery('d-2', 'sub-1')],
        get: async () => ({ id: 'sub-1', url: 'https://doesnotexist.invalid/', enabled: true }),
      } as unknown as ConductorWebhookSubscriptionStore,
      dispatcher: {
        attempt: async () => {
          throw transportError;
        },
      } as unknown as ConductorWebhookDispatcher,
      log: (msg) => logs.push(msg),
    });
    await w3.tick();

    assert.equal(logs.length, 3, JSON.stringify(logs));
    for (const line of logs) {
      assert.match(line, /ENOTFOUND/, `every retry-worker log must name the cause, got: ${line}`);
      assert.match(line, /doesnotexist\.invalid/);
    }
  });
});
