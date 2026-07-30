import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import {
  InMemoryTaskStore,
  TaskLeaseLostError,
  runTaskReaperOnce,
} from '@omadia/orchestrator';

/**
 * W2-2 — the seam's claim/lease + terminal-transition + orphan-reaper
 * semantics, on the reference implementor.
 *
 * These are behaviour assertions, not mock-call counts: every test here fails
 * for a real reason if the invariant is broken (verified by deliberately
 * breaking each one, rebuilding, and confirming a failure — see the delivery
 * report's mutation-check table).
 */

function driven(startMs: number): { store: InMemoryTaskStore; advance: (ms: number) => void; nowMs: () => number } {
  let clock = startMs;
  const store = new InMemoryTaskStore({ clock: () => clock });
  return {
    store,
    advance: (ms: number): void => {
      clock += ms;
    },
    nowMs: (): number => clock,
  };
}

describe('tasks/InMemoryTaskStore — claim + lease', () => {
  it('creates a task as `working` with no lease', async () => {
    const store = new InMemoryTaskStore();
    const t = await store.create({ kind: 'k', input: { a: 1 } });
    assert.equal(t.status, 'working');
    assert.equal(t.claimedBy, null);
    assert.equal(t.phase, 'queued');
    assert.equal(t.endedAt, null);
  });

  it('rejects a non-UUID lease loudly instead of coercing it', async () => {
    const store = new InMemoryTaskStore();
    await store.create({ kind: 'k', input: {} });
    await assert.rejects(() => store.claimNextPending('not-a-uuid'), TypeError);
  });

  it('hands one task to exactly ONE of two concurrent claimers', async () => {
    const store = new InMemoryTaskStore();
    const created = await store.create({ kind: 'k', input: { n: 1 } });

    const leaseA = randomUUID();
    const leaseB = randomUUID();
    const [a, b] = await Promise.all([
      store.claimNextPending(leaseA),
      store.claimNextPending(leaseB),
    ]);

    const winners = [a, b].filter((r) => r !== null);
    assert.equal(winners.length, 1, 'exactly one claimer must win');
    assert.equal(winners[0]?.descriptor.id, created.id);
    // And the winner's lease is the one actually stamped on the row.
    const after = await store.get(created.id);
    assert.ok(after?.claimedBy === leaseA || after?.claimedBy === leaseB);
    assert.equal(after?.claimedBy, winners[0]?.descriptor.claimedBy);
  });

  it('claims oldest-first', async () => {
    const { store, advance } = driven(1_000);
    const first = await store.create({ kind: 'k', input: { n: 1 } });
    advance(1_000);
    await store.create({ kind: 'k', input: { n: 2 } });

    const claimed = await store.claimNextPending(randomUUID());
    assert.equal(claimed?.descriptor.id, first.id);
  });

  it('honours a kind filter and leaves other kinds unclaimed', async () => {
    const store = new InMemoryTaskStore();
    const other = await store.create({ kind: 'other', input: {} });
    const wanted = await store.create({ kind: 'wanted', input: {} });

    const claimed = await store.claimNextPending(randomUUID(), 'wanted');
    assert.equal(claimed?.descriptor.id, wanted.id);
    assert.equal((await store.get(other.id))?.claimedBy, null);
  });

  it('returns the stored input to the claimer', async () => {
    const store = new InMemoryTaskStore();
    await store.create({ kind: 'k', input: { question: 'how many?' } });
    const claimed = await store.claimNextPending(randomUUID());
    assert.deepEqual(claimed?.input, { question: 'how many?' });
  });

  it('FENCES every write on the lease — a stale lease cannot mutate', async () => {
    const store = new InMemoryTaskStore();
    const t = await store.create({ kind: 'k', input: {} });
    const good = randomUUID();
    await store.claimNextPending(good);
    const stale = randomUUID();

    await assert.rejects(() => store.heartbeat(t.id, stale), TaskLeaseLostError);
    await assert.rejects(() => store.setPhase(t.id, stale, 'x'), TaskLeaseLostError);
    await assert.rejects(
      () => store.appendEvents(t.id, stale, [{ type: 'log', message: 'm' }]),
      TaskLeaseLostError,
    );
    await assert.rejects(
      () => store.finish(t.id, stale, { status: 'completed', result: 'hijacked' }),
      TaskLeaseLostError,
    );

    // The state the stale lease tried to write must NOT be there.
    const after = await store.get(t.id);
    assert.equal(after?.status, 'working');
    assert.equal(after?.phase, 'queued');
    assert.equal(after?.result, null);
    assert.deepEqual(await store.eventTail(t.id, 10), []);
  });

  it('refuses any write once terminal — the outcome is immutable', async () => {
    const store = new InMemoryTaskStore();
    const t = await store.create({ kind: 'k', input: {} });
    const lease = randomUUID();
    await store.claimNextPending(lease);
    await store.finish(t.id, lease, { status: 'completed', result: 'real answer' });

    // Even the ORIGINAL, correct lease cannot reopen or overwrite it.
    await assert.rejects(
      () => store.finish(t.id, lease, { status: 'failed', error: 'nope' }),
      TaskLeaseLostError,
    );
    await assert.rejects(() => store.heartbeat(t.id, lease), TaskLeaseLostError);

    const after = await store.get(t.id);
    assert.equal(after?.status, 'completed');
    assert.equal(after?.result, 'real answer');
    assert.equal(after?.error, null);
  });

  it('a terminal transition releases the lease and stamps endedAt', async () => {
    const store = new InMemoryTaskStore();
    const t = await store.create({ kind: 'k', input: {} });
    const lease = randomUUID();
    await store.claimNextPending(lease);
    const done = await store.finish(t.id, lease, { status: 'failed', error: 'boom' });

    assert.equal(done.status, 'failed');
    assert.equal(done.error, 'boom');
    assert.equal(done.claimedBy, null);
    assert.ok(done.endedAt !== null);
  });

  it('requireInput releases the lease so the task can be re-claimed', async () => {
    const store = new InMemoryTaskStore();
    const t = await store.create({ kind: 'k', input: {} });
    const lease = randomUUID();
    await store.claimNextPending(lease);
    const gated = await store.requireInput(t.id, lease, 'awaiting_human');

    assert.equal(gated.status, 'input_required');
    assert.equal(gated.claimedBy, null);
    // `input_required` is NOT claimable — only a `working` task is, so the claim
    // loop leaves a human-gated task alone instead of spinning on it.
    assert.equal(await store.claimNextPending(randomUUID()), null);
  });

  it('keeps a bounded event tail in order', async () => {
    const store = new InMemoryTaskStore({ maxEvents: 3 });
    const t = await store.create({ kind: 'k', input: {} });
    const lease = randomUUID();
    await store.claimNextPending(lease);
    for (const n of [1, 2, 3, 4, 5]) {
      await store.appendEvents(t.id, lease, [{ type: 'log', message: `e${String(n)}` }]);
    }
    const tail = await store.eventTail(t.id, 10);
    assert.deepEqual(
      tail.map((e) => e.message),
      ['e3', 'e4', 'e5'],
      'oldest lines drop, newest survive, order preserved',
    );
    assert.deepEqual(tail.map((e) => e.seq), [3, 4, 5], 'seq stays monotonic');
  });
});

describe('tasks/orphan reaper', () => {
  it('force-fails a live task whose worker went silent', async () => {
    const { store, advance } = driven(10_000);
    const t = await store.create({ kind: 'k', input: {} });
    const lease = randomUUID();
    await store.claimNextPending(lease);

    // Not yet stale: the sweep must leave it alone.
    advance(60_000);
    let r = await runTaskReaperOnce(
      store,
      { staleAfterMs: 300_000, purgeTerminalAfterMs: 3_600_000 },
      new Date(10_000 + 60_000),
    );
    assert.equal(r.staleFailed, 0);
    assert.equal((await store.get(t.id))?.status, 'working');

    // Now past the window.
    advance(300_000);
    r = await runTaskReaperOnce(
      store,
      { staleAfterMs: 300_000, purgeTerminalAfterMs: 3_600_000 },
      new Date(10_000 + 360_000),
    );
    assert.equal(r.staleFailed, 1);
    const after = await store.get(t.id);
    assert.equal(after?.status, 'failed');
    assert.match(String(after?.error), /abandoned/);
  });

  it('a ZOMBIE worker cannot overwrite what the reaper recorded', async () => {
    // The race the terminal guard exists for, and the only path that reaches it:
    // the reaper preserves `claimedBy`, so a worker that wakes up after being
    // reaped still presents a MATCHING lease. Only the terminal check stops it.
    const { store } = driven(0);
    const t = await store.create({ kind: 'k', input: {} });
    const lease = randomUUID();
    await store.claimNextPending(lease);

    await runTaskReaperOnce(
      store,
      { staleAfterMs: 1_000, purgeTerminalAfterMs: 3_600_000 },
      new Date(500_000),
    );
    const reaped = await store.get(t.id);
    assert.equal(reaped?.status, 'failed');
    assert.equal(reaped?.claimedBy, lease, 'the reaper keeps the lease on record');

    // Same lease, still matching — every write must still be refused.
    await assert.rejects(
      () => store.finish(t.id, lease, { status: 'completed', result: 'resurrected' }),
      TaskLeaseLostError,
    );
    await assert.rejects(() => store.heartbeat(t.id, lease), TaskLeaseLostError);
    await assert.rejects(
      () => store.appendEvents(t.id, lease, [{ type: 'log', message: 'zombie' }]),
      TaskLeaseLostError,
    );

    const final = await store.get(t.id);
    assert.equal(final?.status, 'failed');
    assert.equal(final?.result, null, 'the zombie result never landed');
    assert.match(String(final?.error), /abandoned/);
  });

  it('reaps a task that was NEVER claimed (no worker ever started)', async () => {
    // The leak the reaper exists for: nothing claimed it, so lastHeartbeatAt is
    // null and a naive sweep keyed only on the heartbeat would skip it forever.
    const { store } = driven(0);
    const t = await store.create({ kind: 'k', input: {} });
    assert.equal((await store.get(t.id))?.lastHeartbeatAt, null);

    const r = await runTaskReaperOnce(
      store,
      { staleAfterMs: 1_000, purgeTerminalAfterMs: 3_600_000 },
      new Date(500_000),
    );
    assert.equal(r.staleFailed, 1);
    assert.equal((await store.get(t.id))?.status, 'failed');
  });

  it('purges terminal tasks past the retain window and keeps in-window ones', async () => {
    const { store } = driven(0);
    const old = await store.create({ kind: 'k', input: {} });
    const leaseOld = randomUUID();
    await store.claimNextPending(leaseOld);
    await store.finish(old.id, leaseOld, { status: 'completed', result: 'a' });

    const r = await runTaskReaperOnce(
      store,
      { staleAfterMs: 1_000_000, purgeTerminalAfterMs: 60_000 },
      new Date(120_000),
    );
    assert.equal(r.purged, 1);
    assert.equal(await store.get(old.id), null, 'purged task is gone');

    // A fresh terminal task survives the same sweep.
    const fresh = await store.create({ kind: 'k', input: {} });
    const leaseFresh = randomUUID();
    await store.claimNextPending(leaseFresh);
    await store.finish(fresh.id, leaseFresh, { status: 'completed', result: 'b' });
    const r2 = await runTaskReaperOnce(
      store,
      { staleAfterMs: 1_000_000, purgeTerminalAfterMs: 3_600_000 },
      new Date(120_001),
    );
    assert.equal(r2.purged, 0);
    assert.ok(await store.get(fresh.id));
  });

  it('rejects non-positive reap windows rather than sweeping everything', async () => {
    const store = new InMemoryTaskStore();
    await assert.rejects(
      () => store.reapOrphans({ staleAfterMs: 0, purgeTerminalAfterMs: 1 }),
      TypeError,
    );
    await assert.rejects(
      () => store.reapOrphans({ staleAfterMs: 1, purgeTerminalAfterMs: -1 }),
      TypeError,
    );
  });
});
