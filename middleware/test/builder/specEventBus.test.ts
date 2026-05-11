import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { SpecEventBus, type SpecBusEvent } from '../../src/plugins/builder/specEventBus.js';

describe('specEventBus', () => {
  describe('subscribe / emit', () => {
    it('delivers an event to a subscriber of the same draft', () => {
      const bus = new SpecEventBus();
      const seen: SpecBusEvent[] = [];
      bus.subscribe('draft-1', (e) => seen.push(e));
      bus.emit('draft-1', { type: 'spec_patch', patches: [], cause: 'agent' });
      assert.equal(seen.length, 1);
      assert.equal(seen[0].type, 'spec_patch');
    });

    it('does not deliver across drafts', () => {
      const bus = new SpecEventBus();
      const aSeen: SpecBusEvent[] = [];
      const bSeen: SpecBusEvent[] = [];
      bus.subscribe('draft-a', (e) => aSeen.push(e));
      bus.subscribe('draft-b', (e) => bSeen.push(e));
      bus.emit('draft-a', { type: 'spec_patch', patches: [], cause: 'user' });
      assert.equal(aSeen.length, 1);
      assert.equal(bSeen.length, 0);
    });

    it('delivers to all subscribers of the same draft (multi-tab)', () => {
      const bus = new SpecEventBus();
      const tabA: SpecBusEvent[] = [];
      const tabB: SpecBusEvent[] = [];
      bus.subscribe('draft-1', (e) => tabA.push(e));
      bus.subscribe('draft-1', (e) => tabB.push(e));
      bus.emit('draft-1', {
        type: 'slot_patch',
        slotKey: 'activate-body',
        source: 'init();',
        cause: 'user',
      });
      assert.equal(tabA.length, 1);
      assert.equal(tabB.length, 1);
    });

    it('emit before any subscribe is a silent no-op', () => {
      const bus = new SpecEventBus();
      assert.doesNotThrow(() =>
        bus.emit('draft-1', { type: 'spec_patch', patches: [], cause: 'agent' }),
      );
      assert.equal(bus.activeDraftCount(), 0);
    });
  });

  describe('unsubscribe', () => {
    it('returns an unsubscribe function that removes the listener', () => {
      const bus = new SpecEventBus();
      const seen: SpecBusEvent[] = [];
      const off = bus.subscribe('draft-1', (e) => seen.push(e));
      bus.emit('draft-1', { type: 'spec_patch', patches: [], cause: 'agent' });
      off();
      bus.emit('draft-1', { type: 'spec_patch', patches: [], cause: 'agent' });
      assert.equal(seen.length, 1);
    });

    it('unsubscribe is idempotent', () => {
      const bus = new SpecEventBus();
      const off = bus.subscribe('draft-1', () => {});
      off();
      assert.doesNotThrow(() => off());
    });

    it('drops the underlying emitter when last listener leaves (GC)', () => {
      const bus = new SpecEventBus();
      const off1 = bus.subscribe('draft-1', () => {});
      const off2 = bus.subscribe('draft-1', () => {});
      assert.equal(bus.activeDraftCount(), 1);
      off1();
      assert.equal(bus.activeDraftCount(), 1, 'emitter still alive while one listener remains');
      off2();
      assert.equal(bus.activeDraftCount(), 0, 'emitter dropped after last unsubscribe');
    });

    it('listenerCount reports zero after GC', () => {
      const bus = new SpecEventBus();
      const off = bus.subscribe('draft-1', () => {});
      assert.equal(bus.listenerCount('draft-1'), 1);
      off();
      assert.equal(bus.listenerCount('draft-1'), 0);
    });
  });

  describe('event variants', () => {
    it('passes spec_patch payload through unchanged', () => {
      const bus = new SpecEventBus();
      const seen: SpecBusEvent[] = [];
      bus.subscribe('draft-1', (e) => seen.push(e));
      const patches = [{ op: 'replace' as const, path: '/name', value: 'X' }];
      bus.emit('draft-1', { type: 'spec_patch', patches, cause: 'agent' });
      assert.equal(seen[0].type, 'spec_patch');
      if (seen[0].type === 'spec_patch') {
        assert.deepEqual(seen[0].patches, patches);
        assert.equal(seen[0].cause, 'agent');
      }
    });

    it('passes slot_patch payload through unchanged', () => {
      const bus = new SpecEventBus();
      const seen: SpecBusEvent[] = [];
      bus.subscribe('draft-1', (e) => seen.push(e));
      bus.emit('draft-1', {
        type: 'slot_patch',
        slotKey: 'activate-body',
        source: 'foo();',
        cause: 'user',
      });
      assert.equal(seen[0].type, 'slot_patch');
      if (seen[0].type === 'slot_patch') {
        assert.equal(seen[0].slotKey, 'activate-body');
        assert.equal(seen[0].source, 'foo();');
      }
    });
  });

  describe('isolation across instances', () => {
    it('two bus instances do not share listeners', () => {
      const busA = new SpecEventBus();
      const busB = new SpecEventBus();
      const seen: SpecBusEvent[] = [];
      busA.subscribe('draft-1', (e) => seen.push(e));
      busB.emit('draft-1', { type: 'spec_patch', patches: [], cause: 'agent' });
      assert.equal(seen.length, 0);
    });
  });
});
