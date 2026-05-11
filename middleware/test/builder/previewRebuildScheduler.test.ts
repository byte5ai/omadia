import { describe, it, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';

import { PreviewRebuildScheduler } from '../../src/plugins/builder/previewRebuildScheduler.js';

interface FakeTimer {
  fn: () => void;
  ms: number;
  cleared: boolean;
}

class FakeClock {
  private nextHandle = 1;
  readonly active = new Map<number, FakeTimer>();

  setTimer = (fn: () => void, ms: number): unknown => {
    const handle = this.nextHandle++;
    this.active.set(handle, { fn, ms, cleared: false });
    return handle;
  };

  clearTimer = (handle: unknown): void => {
    const t = this.active.get(handle as number);
    if (t) {
      t.cleared = true;
      this.active.delete(handle as number);
    }
  };

  /** Fire the most-recently-scheduled timer (LIFO). */
  fireLatest(): void {
    const handles = Array.from(this.active.keys());
    if (handles.length === 0) throw new Error('no active timers');
    const last = handles[handles.length - 1];
    if (last === undefined) throw new Error('no active timers');
    const t = this.active.get(last);
    if (!t) throw new Error('timer vanished');
    this.active.delete(last);
    t.fn();
  }

  fireAll(): number {
    const handles = Array.from(this.active.keys()).sort((a, b) => a - b);
    let n = 0;
    for (const h of handles) {
      const t = this.active.get(h);
      if (!t) continue;
      this.active.delete(h);
      t.fn();
      n += 1;
    }
    return n;
  }
}

describe('PreviewRebuildScheduler', () => {
  let clock: FakeClock;
  let invalidates: Array<{ user: string; draft: string }>;
  let rebuilds: Array<{ user: string; draft: string }>;
  let rebuildResolvers: Array<() => void>;
  let scheduler: PreviewRebuildScheduler;

  beforeEach(() => {
    clock = new FakeClock();
    invalidates = [];
    rebuilds = [];
    rebuildResolvers = [];
    scheduler = new PreviewRebuildScheduler({
      debounceMs: 100,
      invalidate: (u, d) => {
        invalidates.push({ user: u, draft: d });
      },
      rebuild: async (u, d) => {
        rebuilds.push({ user: u, draft: d });
        return new Promise<void>((resolve) => {
          rebuildResolvers.push(resolve);
        });
      },
      onError: () => {},
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
  });

  it('invalidates immediately and arms a single rebuild on schedule()', () => {
    scheduler.schedule('a@x', 'd1');
    assert.deepEqual(invalidates, [{ user: 'a@x', draft: 'd1' }]);
    assert.equal(scheduler.size(), 1);
    assert.equal(rebuilds.length, 0, 'rebuild not yet fired');

    clock.fireLatest();
    assert.equal(rebuilds.length, 1);
    assert.deepEqual(rebuilds[0], { user: 'a@x', draft: 'd1' });
    rebuildResolvers[0]?.();
  });

  it('coalesces rapid schedule() calls into a single rebuild', () => {
    scheduler.schedule('a@x', 'd1');
    scheduler.schedule('a@x', 'd1');
    scheduler.schedule('a@x', 'd1');

    // 3 invalidates fired (every mutation marks the cache stale immediately).
    assert.equal(invalidates.length, 3);
    // Only one timer pending.
    assert.equal(scheduler.size(), 1);

    clock.fireLatest();
    assert.equal(rebuilds.length, 1);
    rebuildResolvers[0]?.();
  });

  it('keeps separate timers per (user, draft)', () => {
    scheduler.schedule('a@x', 'd1');
    scheduler.schedule('a@x', 'd2');
    scheduler.schedule('b@x', 'd1');
    assert.equal(scheduler.size(), 3);
    clock.fireAll();
    assert.equal(rebuilds.length, 3);
    rebuildResolvers.forEach((r) => r());
  });

  it('cancel() removes a pending timer without invalidating', () => {
    scheduler.schedule('a@x', 'd1');
    assert.equal(scheduler.size(), 1);
    const cancelled = scheduler.cancel('a@x', 'd1');
    assert.equal(cancelled, true);
    assert.equal(scheduler.size(), 0);
    // No rebuilds at all.
    assert.equal(clock.active.size, 0);
    assert.equal(rebuilds.length, 0);
  });

  it('cancel() returns false when nothing is pending', () => {
    assert.equal(scheduler.cancel('a@x', 'never'), false);
  });

  it('cancelAll() drops every pending timer', () => {
    scheduler.schedule('a@x', 'd1');
    scheduler.schedule('b@x', 'd2');
    const cleared = scheduler.cancelAll();
    assert.equal(cleared, 2);
    assert.equal(scheduler.size(), 0);
    assert.equal(clock.active.size, 0);
  });

  it('routes rebuild errors through onError without throwing', async () => {
    const errors: Array<{ user: string; draft: string; err: unknown }> = [];
    const explodingScheduler = new PreviewRebuildScheduler({
      debounceMs: 50,
      invalidate: () => {},
      rebuild: async () => {
        throw new Error('rebuild-blew-up');
      },
      onError: (u, d, err) => errors.push({ user: u, draft: d, err }),
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });

    explodingScheduler.schedule('a@x', 'd1');
    clock.fireLatest();

    // Let the microtask flush so the rejection routes into onError.
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(errors.length, 1);
    assert.equal(errors[0]?.user, 'a@x');
    assert.equal(errors[0]?.draft, 'd1');
    assert.match(
      (errors[0]?.err as Error).message,
      /rebuild-blew-up/,
    );
  });
});
