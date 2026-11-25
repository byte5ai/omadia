import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  DraftTurnLock,
  draftTurnStopReason,
} from '../../src/plugins/builder/draftTurnLock.js';

const turn = (turnId: string, draftId = 'd1') => ({
  draftId,
  turnId,
  userEmail: 'a@example.com',
  source: 'chat' as const,
});

describe('DraftTurnLock (#2214)', () => {
  it('admits one turn per draft and reports the holder', () => {
    const lock = new DraftTurnLock({ now: () => 42 });
    const first = lock.tryAcquire(turn('t1'));
    assert.equal(first.ok, true);
    const second = lock.tryAcquire(turn('t2'));
    assert.equal(second.ok, false);
    if (!second.ok) {
      assert.equal(second.running.turnId, 't1');
      assert.equal(second.running.startedAt, 42);
    }
    // Other drafts are independent.
    assert.equal(lock.tryAcquire(turn('t3', 'd2')).ok, true);
  });

  it('frees the draft on release, and a stale release is a no-op', () => {
    const lock = new DraftTurnLock();
    const first = lock.tryAcquire(turn('t1'));
    assert.ok(first.ok);
    first.lease.release();
    const second = lock.tryAcquire(turn('t2'));
    assert.ok(second.ok);
    first.lease.release();
    assert.equal(lock.running('d1')?.turnId, 't2');
  });

  it('stop aborts only the named turn, with the operator reason', () => {
    const lock = new DraftTurnLock();
    const acquired = lock.tryAcquire(turn('t1'));
    assert.ok(acquired.ok);
    assert.deepEqual(lock.stop('d1', 'other'), { status: 'not_running' });
    assert.equal(acquired.lease.signal.aborted, false);
    assert.equal(lock.stop('d1', 't1').status, 'stopping');
    assert.equal(acquired.lease.signal.aborted, true);
    assert.equal(draftTurnStopReason(acquired.lease.signal), 'operator');
    assert.deepEqual(lock.stop('nope'), { status: 'not_running' });
  });

  it('carries the timeout reason when the holder aborts itself', () => {
    const lock = new DraftTurnLock();
    const acquired = lock.tryAcquire(turn('t1'));
    assert.ok(acquired.ok);
    acquired.lease.abort('timeout');
    acquired.lease.abort('operator');
    assert.equal(draftTurnStopReason(acquired.lease.signal), 'timeout');
  });

  it('whenReleased resolves on release, or false after the wait', async () => {
    const lock = new DraftTurnLock();
    assert.equal(await lock.whenReleased('d1', 't1', 10), true);
    const acquired = lock.tryAcquire(turn('t1'));
    assert.ok(acquired.ok);
    assert.equal(await lock.whenReleased('d1', 't1', 10), false);
    const waiting = lock.whenReleased('d1', 't1', 1_000);
    acquired.lease.release();
    assert.equal(await waiting, true);
  });
});
