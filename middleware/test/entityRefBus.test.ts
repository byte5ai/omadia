import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { EntityRefBus, type EntityRef } from '@omadia/plugin-api';
import { turnContext } from '@omadia/orchestrator';

const newBus = (): EntityRefBus =>
  new EntityRefBus({ getCurrentTurnId: () => turnContext.currentTurnId() });

const ref = (id: number, suffix = ''): EntityRef => ({
  system: 'odoo',
  model: 'hr.employee',
  id,
  displayName: `E${String(id)}${suffix}`,
  op: 'read',
});

describe('EntityRefBus', () => {
  it('collects refs published inside the matching turn context', async () => {
    const bus = newBus();
    const collection = bus.beginCollection('turn-1');

    await turnContext.run({ turnId: 'turn-1', turnDate: '2026-04-19' }, async () => {
      bus.publish(ref(1));
      bus.publish(ref(2));
    });

    assert.deepEqual(
      collection.drain().map((r) => r.id),
      [1, 2],
    );
  });

  it('ignores refs from other turns', async () => {
    const bus = newBus();
    const collectionA = bus.beginCollection('A');
    const collectionB = bus.beginCollection('B');

    await Promise.all([
      turnContext.run({ turnId: 'A', turnDate: '2026-04-19' }, async () => {
        bus.publish(ref(10));
      }),
      turnContext.run({ turnId: 'B', turnDate: '2026-04-19' }, async () => {
        bus.publish(ref(20));
      }),
    ]);

    assert.deepEqual(
      collectionA.drain().map((r) => r.id),
      [10],
    );
    assert.deepEqual(
      collectionB.drain().map((r) => r.id),
      [20],
    );
  });

  it('drops refs published outside any turn context', () => {
    const bus = newBus();
    const collection = bus.beginCollection('T');
    bus.publish(ref(99));
    assert.deepEqual(collection.drain(), []);
  });

  it('drain() is idempotent and returns the collected snapshot', async () => {
    const bus = newBus();
    const collection = bus.beginCollection('X');
    await turnContext.run({ turnId: 'X', turnDate: '2026-04-19' }, async () => {
      bus.publish(ref(1));
    });
    const first = collection.drain();
    const second = collection.drain();
    assert.equal(first.length, 1);
    assert.equal(second.length, 0);
  });

  it('does not leak listeners between collections', async () => {
    const bus = newBus();
    for (let i = 0; i < 200; i++) {
      const c = bus.beginCollection(`t-${String(i)}`);
      c.drain();
    }
    // No assertion needed — if we leaked, setMaxListeners(256) would fire
    // MaxListenersExceededWarning and a future publish would still work.
    await turnContext.run({ turnId: 'final', turnDate: '2026-04-19' }, async () => {
      bus.publish(ref(1));
    });
  });
});
