import { describe, it, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  PreviewCache,
  type EnsureWarmOptions,
} from '../../src/plugins/builder/previewCache.js';
import type {
  PreviewActivateOptions,
  PreviewHandle,
} from '../../src/plugins/builder/previewRuntime.js';

interface FakeHandle {
  handle: PreviewHandle;
  closeCount: () => number;
}

function makeFakeHandle(draftId: string, rev: number): FakeHandle {
  let closes = 0;
  const handle: PreviewHandle = {
    draftId,
    agentId: 'fake-agent',
    rev,
    toolkit: { tools: [] },
    previewDir: `/tmp/${draftId}-${rev}`,
    routeCaptures: [],
    close: async () => {
      closes += 1;
    },
  };
  return { handle, closeCount: () => closes };
}

interface FakeActivate {
  fn: (opts: PreviewActivateOptions) => Promise<PreviewHandle>;
  callCount: () => number;
  handles: FakeHandle[];
}

function fakeActivate(): FakeActivate {
  const handles: FakeHandle[] = [];
  let calls = 0;
  return {
    fn: async (opts) => {
      calls += 1;
      const h = makeFakeHandle(opts.draftId, opts.rev);
      handles.push(h);
      return h.handle;
    },
    callCount: () => calls,
    handles,
  };
}

function buildCallback(rev = 1): EnsureWarmOptions['build'] {
  return async () => ({
    zipBuffer: Buffer.alloc(0),
    rev,
    configValues: {},
    secretValues: {},
  });
}

describe('PreviewCache', () => {
  let activate: FakeActivate;
  let cache: PreviewCache;

  beforeEach(() => {
    activate = fakeActivate();
    cache = new PreviewCache({
      activate: activate.fn,
      warmSlots: 3,
      logger: () => {},
    });
  });

  describe('ensureWarm', () => {
    it('builds + activates on cold cache and stores the handle', async () => {
      const handle = await cache.ensureWarm({
        userEmail: 'a@x',
        draftId: 'd1',
        build: buildCallback(),
      });
      assert.ok(handle);
      assert.equal(activate.callCount(), 1);
      assert.equal(cache.size, 1);
      assert.equal(cache.sizeForUser('a@x'), 1);
    });

    it('returns the same handle on warm-hit without re-activating', async () => {
      const first = await cache.ensureWarm({
        userEmail: 'a@x',
        draftId: 'd1',
        build: buildCallback(),
      });
      const second = await cache.ensureWarm({
        userEmail: 'a@x',
        draftId: 'd1',
        build: buildCallback(),
      });
      assert.equal(first, second);
      assert.equal(activate.callCount(), 1);
    });

    it('evicts the user\'s oldest preview when over the cap', async () => {
      // Cap=3; insert 4 distinct drafts → first one (d1) gets evicted.
      const h1 = await cache.ensureWarm({
        userEmail: 'a@x',
        draftId: 'd1',
        build: buildCallback(),
      });
      // Touch d1 here would make it most-recently-used; intentionally don't touch.
      // Make timestamps deterministic-ish by inserting in order.
      await new Promise((r) => setTimeout(r, 2));
      await cache.ensureWarm({
        userEmail: 'a@x',
        draftId: 'd2',
        build: buildCallback(),
      });
      await new Promise((r) => setTimeout(r, 2));
      await cache.ensureWarm({
        userEmail: 'a@x',
        draftId: 'd3',
        build: buildCallback(),
      });
      await new Promise((r) => setTimeout(r, 2));
      await cache.ensureWarm({
        userEmail: 'a@x',
        draftId: 'd4',
        build: buildCallback(),
      });

      assert.equal(cache.sizeForUser('a@x'), 3);
      assert.equal(cache.size, 3);
      // d1's handle should be closed
      const evictedHandle = activate.handles.find(
        (fh) => fh.handle.draftId === 'd1',
      );
      assert.ok(evictedHandle);
      assert.equal(evictedHandle.closeCount(), 1);
    });

    it('treats per-user caps independently', async () => {
      // Each user has cap=3; total can exceed 3.
      for (const draftId of ['d1', 'd2', 'd3']) {
        await cache.ensureWarm({
          userEmail: 'a@x',
          draftId,
          build: buildCallback(),
        });
      }
      for (const draftId of ['d1', 'd2', 'd3']) {
        await cache.ensureWarm({
          userEmail: 'b@x',
          draftId,
          build: buildCallback(),
        });
      }
      assert.equal(cache.size, 6);
      assert.equal(cache.sizeForUser('a@x'), 3);
      assert.equal(cache.sizeForUser('b@x'), 3);
    });

    it('rebuilds + closes the stale handle when the entry was invalidated', async () => {
      const first = await cache.ensureWarm({
        userEmail: 'a@x',
        draftId: 'd1',
        build: buildCallback(1),
      });
      cache.invalidate('a@x', 'd1');

      const second = await cache.ensureWarm({
        userEmail: 'a@x',
        draftId: 'd1',
        build: buildCallback(2),
      });

      assert.notEqual(first, second);
      assert.equal(activate.callCount(), 2);
      // First handle closed once
      const firstFake = activate.handles[0]!;
      assert.equal(firstFake.closeCount(), 1);
    });

    it('touches LRU order on cache hit (touched entry survives next eviction)', async () => {
      await cache.ensureWarm({
        userEmail: 'a@x',
        draftId: 'd1',
        build: buildCallback(),
      });
      await new Promise((r) => setTimeout(r, 2));
      await cache.ensureWarm({
        userEmail: 'a@x',
        draftId: 'd2',
        build: buildCallback(),
      });
      await new Promise((r) => setTimeout(r, 2));
      await cache.ensureWarm({
        userEmail: 'a@x',
        draftId: 'd3',
        build: buildCallback(),
      });

      // Touch d1 (oldest) so it becomes most-recently-used.
      await new Promise((r) => setTimeout(r, 2));
      cache.get('a@x', 'd1');

      // Insert d4 — this should evict d2 (now oldest), NOT d1.
      await new Promise((r) => setTimeout(r, 2));
      await cache.ensureWarm({
        userEmail: 'a@x',
        draftId: 'd4',
        build: buildCallback(),
      });

      const d1 = activate.handles.find((h) => h.handle.draftId === 'd1')!;
      const d2 = activate.handles.find((h) => h.handle.draftId === 'd2')!;
      assert.equal(d1.closeCount(), 0, 'd1 should have survived (was touched)');
      assert.equal(d2.closeCount(), 1, 'd2 should have been evicted');
    });
  });

  describe('get', () => {
    it('returns null on cold miss', () => {
      assert.equal(cache.get('a@x', 'd1'), null);
    });

    it('returns null after invalidate', async () => {
      await cache.ensureWarm({
        userEmail: 'a@x',
        draftId: 'd1',
        build: buildCallback(),
      });
      cache.invalidate('a@x', 'd1');
      assert.equal(cache.get('a@x', 'd1'), null);
    });
  });

  describe('evict', () => {
    it('removes the entry and closes the handle', async () => {
      await cache.ensureWarm({
        userEmail: 'a@x',
        draftId: 'd1',
        build: buildCallback(),
      });
      const removed = await cache.evict('a@x', 'd1');
      assert.equal(removed, true);
      assert.equal(cache.size, 0);
      const fh = activate.handles[0]!;
      assert.equal(fh.closeCount(), 1);
    });

    it('returns false when nothing matches', async () => {
      const removed = await cache.evict('a@x', 'nonexistent');
      assert.equal(removed, false);
    });
  });

  describe('dropAll', () => {
    it('closes all entries for the given user only', async () => {
      for (const draftId of ['d1', 'd2']) {
        await cache.ensureWarm({
          userEmail: 'a@x',
          draftId,
          build: buildCallback(),
        });
      }
      await cache.ensureWarm({
        userEmail: 'b@x',
        draftId: 'd1',
        build: buildCallback(),
      });

      await cache.dropAll('a@x');
      assert.equal(cache.sizeForUser('a@x'), 0);
      assert.equal(cache.sizeForUser('b@x'), 1);
      assert.equal(cache.size, 1);
    });
  });

  describe('closeAll', () => {
    it('closes everything across all users', async () => {
      await cache.ensureWarm({
        userEmail: 'a@x',
        draftId: 'd1',
        build: buildCallback(),
      });
      await cache.ensureWarm({
        userEmail: 'b@x',
        draftId: 'd1',
        build: buildCallback(),
      });
      await cache.closeAll();
      assert.equal(cache.size, 0);
      assert.equal(cache.sizeForUser('a@x'), 0);
      assert.equal(cache.sizeForUser('b@x'), 0);
      for (const h of activate.handles) {
        assert.equal(h.closeCount(), 1);
      }
    });
  });
});
