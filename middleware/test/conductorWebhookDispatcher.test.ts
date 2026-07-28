import { strict as assert } from 'node:assert';
import crypto from 'node:crypto';
import { describe, it } from 'node:test';

import type { JsonObject } from '@omadia/conductor-core';

import { ConductorWebhookDispatcher } from '../src/conductor/webhookDispatcher.js';
import type {
  ConductorWebhookDelivery,
  ConductorWebhookSubscription,
  ConductorWebhookSubscriptionStore,
} from '../src/conductor/webhookSubscriptionStore.js';

// Issue #437 — outbound dispatcher: HMAC-signs every delivery, retries a failed
// attempt with exponential backoff up to maxAttempts, and never lets a broken
// subscription (missing secret, disabled) spin retries it can never win.

const SECRET = 'sub-secret';

function subscription(over: Partial<ConductorWebhookSubscription> = {}): ConductorWebhookSubscription {
  return {
    id: 'sub-1',
    url: 'https://example.com/hook',
    event: 'run.completed',
    description: null,
    enabled: true,
    createdBy: 'operator',
    createdAt: new Date(),
    ...over,
  };
}

function delivery(over: Partial<ConductorWebhookDelivery> = {}): ConductorWebhookDelivery {
  return {
    id: 'del-1',
    subscriptionId: 'sub-1',
    event: 'run.completed',
    payload: { runId: 'run-1' },
    status: 'pending',
    attempts: 0,
    lastError: null,
    nextAttemptAt: new Date(),
    deliveredAt: null,
    createdAt: new Date(),
    ...over,
  };
}

interface FakeStore {
  store: ConductorWebhookSubscriptionStore;
  createCalls: Array<{ subscriptionId: string; event: string; payload: JsonObject }>;
  successes: string[];
  failures: Array<{ id: string; error: string; nextAttemptAt: Date | null }>;
  /** Resolves once `deliverEvent`'s fire-and-forget attempt(s) have all settled — the
   *  route/executor never awaits them either, so tests must wait on this instead of
   *  the `deliverEvent`/`attempt` return value. */
  settled: () => Promise<void>;
}

function fakeStore(opts: { subscriptions?: ConductorWebhookSubscription[]; secret?: string | undefined } = {}): FakeStore {
  const createCalls: FakeStore['createCalls'] = [];
  const successes: string[] = [];
  const failures: FakeStore['failures'] = [];
  const subs = opts.subscriptions ?? [subscription()];
  const pending: Array<Promise<unknown>> = [];
  const store = {
    listEnabledForEvent: async (event: string) => subs.filter((s) => s.enabled && s.event === event),
    createDelivery: async (input: { subscriptionId: string; event: string; payload: JsonObject }) => {
      createCalls.push(input);
      return delivery({ subscriptionId: input.subscriptionId, event: input.event, payload: input.payload });
    },
    getSecret: async () => opts.secret,
    recordSuccess: async (id: string) => {
      successes.push(id);
    },
    recordFailure: async (id: string, error: string, nextAttemptAt: Date | null) => {
      failures.push({ id, error, nextAttemptAt });
    },
  };
  // Wrap sendRequest calls transparently via the dispatcher's own promise chain is not
  // observable here, so `settled()` just flushes the microtask queue a bounded number
  // of times — every awaited step in `attempt` is a plain Promise, no real timers.
  const settled = async (): Promise<void> => {
    for (let i = 0; i < 20; i++) {
      await Promise.resolve();
    }
    void pending;
  };
  return { store: store as unknown as ConductorWebhookSubscriptionStore, createCalls, successes, failures, settled };
}

describe('ConductorWebhookDispatcher', () => {
  it('signs the delivery body with the subscription secret and records success on a 2xx', async () => {
    const fake = fakeStore({ secret: SECRET });
    let seenHeaders: Record<string, string> | undefined;
    let seenBody: string | undefined;
    const dispatcher = new ConductorWebhookDispatcher({
      store: fake.store,
      sendRequest: async (input) => {
        seenHeaders = input.headers;
        seenBody = input.body;
        return { ok: true, status: 200, bodySnippet: '' };
      },
    });

    await dispatcher.deliverEvent('run.completed', { runId: 'r-1' });
    await fake.settled();

    assert.equal(fake.createCalls.length, 1);
    assert.equal(fake.successes.length, 1);
    assert.ok(seenBody);
    assert.equal(seenHeaders?.['x-omadia-signature'], `sha256=${crypto.createHmac('sha256', SECRET).update(seenBody!).digest('hex')}`);
    assert.equal(seenHeaders?.['x-omadia-event'], 'run.completed');
  });

  it('does not fan out to a subscription for a different event or a disabled one', async () => {
    const fake = fakeStore({
      subscriptions: [
        subscription({ id: 'sub-a', event: 'run.completed' }),
        subscription({ id: 'sub-b', event: 'run.failed' }),
        subscription({ id: 'sub-c', event: 'run.completed', enabled: false }),
      ],
      secret: SECRET,
    });
    const dispatcher = new ConductorWebhookDispatcher({
      store: fake.store,
      sendRequest: async () => ({ ok: true, status: 200, bodySnippet: '' }),
    });

    await dispatcher.deliverEvent('run.completed', {});

    assert.equal(fake.createCalls.length, 1);
    assert.equal(fake.createCalls[0]?.subscriptionId, 'sub-a');
  });

  it('retries a failed attempt with growing backoff until maxAttempts, then exhausts', async () => {
    const fake = fakeStore({ secret: SECRET });
    const dispatcher = new ConductorWebhookDispatcher({
      store: fake.store,
      maxAttempts: 3,
      sendRequest: async () => ({ ok: false, status: 500, bodySnippet: 'boom' }),
    });

    await dispatcher.attempt(delivery({ attempts: 0 }), subscription());
    assert.equal(fake.failures[0]?.nextAttemptAt !== null, true); // attempt 1/3 → retry

    await dispatcher.attempt(delivery({ attempts: 1 }), subscription());
    assert.equal(fake.failures[1]?.nextAttemptAt !== null, true); // attempt 2/3 → retry

    await dispatcher.attempt(delivery({ attempts: 2 }), subscription());
    assert.equal(fake.failures[2]?.nextAttemptAt, null); // attempt 3/3 → exhausted

    // Backoff strictly grows between the two retried attempts.
    const first = fake.failures[0]!.nextAttemptAt!.getTime();
    const second = fake.failures[1]!.nextAttemptAt!.getTime();
    assert.ok(second - Date.now() > first - Date.now());
  });

  it('exhausts immediately (no HTTP call) when the subscription secret is missing', async () => {
    const fake = fakeStore({ secret: undefined });
    let called = false;
    const dispatcher = new ConductorWebhookDispatcher({
      store: fake.store,
      sendRequest: async () => {
        called = true;
        return { ok: true, status: 200, bodySnippet: '' };
      },
    });

    await dispatcher.attempt(delivery(), subscription());

    assert.equal(called, false);
    assert.equal(fake.failures[0]?.nextAttemptAt, null);
    assert.match(fake.failures[0]?.error ?? '', /secret/);
  });

  it('exhausts immediately (no HTTP call) when the subscription is disabled', async () => {
    const fake = fakeStore({ secret: SECRET });
    let called = false;
    const dispatcher = new ConductorWebhookDispatcher({
      store: fake.store,
      sendRequest: async () => {
        called = true;
        return { ok: true, status: 200, bodySnippet: '' };
      },
    });

    await dispatcher.attempt(delivery(), subscription({ enabled: false }));

    assert.equal(called, false);
    assert.equal(fake.failures[0]?.nextAttemptAt, null);
  });
});
