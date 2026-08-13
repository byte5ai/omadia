import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import { TaskLeaseLostError, type TaskStore } from '@omadia/orchestrator';

/**
 * Issue #560 — the SHARED `TaskStore` conformance suite.
 *
 * The whole point of a durable second implementor is that it behaves
 * identically to the in-memory reference. So the claim/lease, terminal, park,
 * RESUME and reaper invariants are asserted ONCE here and run against BOTH
 * stores (in-memory in-process, durable against real Postgres) — a divergence
 * fails one side and is caught, rather than each store pinning its own subtly
 * different behaviour.
 *
 * These are read-back assertions: every check reads the value out of the store
 * (`get`, `list`, `eventTail`) after the write, never trusts the write's return
 * value alone.
 *
 * `makeStore` returns a FRESH, EMPTY store per call — a new `InMemoryTaskStore`,
 * or a `DurableTaskStore` over a just-truncated table — so `list`/`reapOrphans`
 * see only the rows a single test created.
 */

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/** A far-future clock for the reaper, so a just-created row is unambiguously
 *  past any window measured from real time (both stores stamp rows with real
 *  time — `Date.now()` / `now()`). */
const HOUR_MS = 60 * 60_000;

export function runTaskStoreConformance(
  label: string,
  makeStore: () => Promise<TaskStore>,
): void {
  describe(`TaskStore conformance — ${label}`, () => {
    it('create → get round-trips the descriptor and starts working/queued', async () => {
      const store = await makeStore();
      const created = await store.create({
        kind: 'k',
        input: { q: 'hello' },
        createdBy: 'alice',
      });
      const got = await store.get(created.id);
      assert.ok(got);
      assert.equal(got.id, created.id);
      assert.equal(got.kind, 'k');
      assert.equal(got.status, 'working');
      assert.equal(got.phase, 'queued');
      assert.equal(got.claimedBy, null);
      assert.equal(got.createdBy, 'alice');
      assert.equal(got.result, null);
      assert.equal(got.endedAt, null);
    });

    it('claimNextPending stamps a lease and hands back the STORED input', async () => {
      const store = await makeStore();
      await store.create({ kind: 'k', input: { payload: 42 } });
      const lease = randomUUID();
      const claimed = await store.claimNextPending(lease);
      assert.ok(claimed);
      assert.deepEqual(claimed.input, { payload: 42 });
      const row = await store.get(claimed.descriptor.id);
      assert.equal(row?.claimedBy, lease, 'the lease is persisted on the row');
      // A second claim finds nothing — the only task is now claimed.
      assert.equal(await store.claimNextPending(randomUUID()), null);
    });

    it('claim is oldest-first and honours a kind filter', async () => {
      const store = await makeStore();
      const first = await store.create({ kind: 'k', input: { n: 1 } });
      await sleep(5); // distinct createdAt on both stores
      await store.create({ kind: 'k', input: { n: 2 } });
      await store.create({ kind: 'other', input: { n: 3 } });

      const claimed = await store.claimNextPending(randomUUID(), 'k');
      assert.equal(claimed?.descriptor.id, first.id, 'oldest of the kind is claimed');

      // The 'other' task is untouched by a 'k' claim.
      const otherClaim = await store.claimNextPending(randomUUID(), 'nope');
      assert.equal(otherClaim, null);
    });

    it('the taskId hint claims THAT task, not the pool head', async () => {
      const store = await makeStore();
      const oldest = await store.create({ kind: 'k', input: { which: 'oldest' } });
      await sleep(5);
      const wanted = await store.create({ kind: 'k', input: { which: 'wanted' } });

      const claimed = await store.claimNextPending(randomUUID(), 'k', wanted.id);
      assert.equal(claimed?.descriptor.id, wanted.id);
      assert.deepEqual(claimed?.input, { which: 'wanted' });
      assert.equal((await store.get(oldest.id))?.claimedBy, null);
    });

    it('a lease-fenced write with the WRONG lease throws TaskLeaseLostError', async () => {
      const store = await makeStore();
      const t = await store.create({ kind: 'k', input: {} });
      await store.claimNextPending(randomUUID()); // claimed by some other lease
      await assert.rejects(
        () => store.heartbeat(t.id, randomUUID()),
        TaskLeaseLostError,
      );
      await assert.rejects(
        () => store.setPhase(t.id, randomUUID(), 'x'),
        TaskLeaseLostError,
      );
    });

    it('terminal transition releases the lease and is then immutable', async () => {
      const store = await makeStore();
      const t = await store.create({ kind: 'k', input: {} });
      const lease = randomUUID();
      await store.claimNextPending(lease);
      const done = await store.finish(t.id, lease, {
        status: 'completed',
        result: 'the answer',
      });
      assert.equal(done.status, 'completed');
      assert.equal(done.claimedBy, null);
      assert.ok(done.endedAt !== null);

      const row = await store.get(t.id);
      assert.equal(row?.result, 'the answer');
      // Terminal immutability: even the owning lease cannot write again.
      await assert.rejects(() => store.heartbeat(t.id, lease), TaskLeaseLostError);
      await assert.rejects(
        () => store.finish(t.id, lease, { status: 'failed', error: 'no' }),
        TaskLeaseLostError,
      );
    });

    it('requireInput parks the task and releases the lease; a parked task is NOT claimable', async () => {
      // The line-167 invariant, held by both stores: `claimNextPending` never
      // hands back an `input_required` task — un-parking is a distinct act.
      const store = await makeStore();
      const t = await store.create({ kind: 'k', input: {} });
      const lease = randomUUID();
      await store.claimNextPending(lease);
      const parked = await store.requireInput(t.id, lease, 'awaiting_human');
      assert.equal(parked.status, 'input_required');
      assert.equal(parked.phase, 'awaiting_human');
      assert.equal(parked.claimedBy, null);
      assert.equal(await store.claimNextPending(randomUUID()), null);
    });

    it('provideInput resumes input_required → working, REPLACES the input, and it re-claims', async () => {
      // The #560 resume transition. The resumed input carries the human answer;
      // the re-driven executor must see it, not the original.
      const store = await makeStore();
      const t = await store.create({ kind: 'k', input: { answer: null } });
      const lease = randomUUID();
      await store.claimNextPending(lease);
      await store.requireInput(t.id, lease);

      const resumed = await store.provideInput(t.id, { answer: 'yes' });
      assert.equal(resumed.status, 'working');
      assert.equal(resumed.claimedBy, null, 'resumed back into the unclaimed pool');

      const reclaim = await store.claimNextPending(randomUUID());
      assert.equal(reclaim?.descriptor.id, t.id, 'the un-parked task is claimable again');
      assert.deepEqual(
        reclaim?.input,
        { answer: 'yes' },
        'the executor sees the resumed input, not the original',
      );
    });

    it('provideInput is idempotent on a working task and rejects a terminal/missing one', async () => {
      const store = await makeStore();
      const t = await store.create({ kind: 'k', input: {} });
      // Already working (never parked) → no-op, returns it.
      const same = await store.provideInput(t.id, { x: 1 });
      assert.equal(same.status, 'working');

      const lease = randomUUID();
      await store.claimNextPending(lease);
      await store.finish(t.id, lease, { status: 'completed', result: 'r' });
      await assert.rejects(() => store.provideInput(t.id, {}), TaskLeaseLostError);
      await assert.rejects(() => store.provideInput(randomUUID(), {}), TaskLeaseLostError);
    });

    it('appendEvents tail is oldest-first with a monotonic seq starting at 1', async () => {
      const store = await makeStore();
      const t = await store.create({ kind: 'k', input: {} });
      const lease = randomUUID();
      await store.claimNextPending(lease);
      await store.appendEvents(t.id, lease, [
        { type: 'log', message: 'one' },
        { type: 'log', message: 'two' },
      ]);
      await store.appendEvents(t.id, lease, [{ type: 'phase', message: 'three' }]);

      const tail = await store.eventTail(t.id, 10);
      assert.deepEqual(
        tail.map((e) => e.message),
        ['one', 'two', 'three'],
      );
      assert.deepEqual(
        tail.map((e) => e.seq),
        [1, 2, 3],
      );
    });

    it('reapOrphans fails an abandoned working task (lease preserved) and purges terminal rows', async () => {
      const store = await makeStore();
      const abandoned = await store.create({ kind: 'k', input: {} });
      const claimLease = randomUUID();
      await store.claimNextPending(claimLease);

      const done = await store.create({ kind: 'k', input: {} });
      const doneLease = randomUUID();
      await store.claimNextPending(doneLease, undefined, done.id);
      await store.finish(done.id, doneLease, { status: 'completed', result: 'r' });

      const future = new Date(Date.now() + HOUR_MS);
      const result = await store.reapOrphans({
        now: future,
        staleAfterMs: 15 * 60_000,
        purgeTerminalAfterMs: 30 * 60_000,
      });
      assert.equal(result.staleFailed, 1, 'the abandoned working task is force-failed');
      assert.equal(result.purged, 1, 'the terminal task is purged');

      const row = await store.get(abandoned.id);
      assert.equal(row?.status, 'failed');
      assert.match(String(row?.error), /abandoned/);
      // The dead lease is deliberately PRESERVED so the terminal guard, not the
      // lease check, rejects a zombie worker waking up later.
      assert.equal(row?.claimedBy, claimLease);
      assert.equal(await store.get(done.id), null, 'the purged row is gone');
    });

    it('reapOrphans leaves a parked task alone unless parkedStaleAfterMs is given', async () => {
      const store = await makeStore();
      const t = await store.create({ kind: 'k', input: {} });
      const lease = randomUUID();
      await store.claimNextPending(lease);
      await store.requireInput(t.id, lease);

      const future = new Date(Date.now() + HOUR_MS);
      // No parked window → a parked task is never force-failed.
      const first = await store.reapOrphans({
        now: future,
        staleAfterMs: 60_000,
        purgeTerminalAfterMs: HOUR_MS,
      });
      assert.equal(first.staleFailed, 0);
      assert.equal((await store.get(t.id))?.status, 'input_required');

      // With a parked window it expires, with its OWN error wording.
      const second = await store.reapOrphans({
        now: future,
        staleAfterMs: 60_000,
        parkedStaleAfterMs: 60_000,
        purgeTerminalAfterMs: HOUR_MS,
      });
      assert.equal(second.staleFailed, 1);
      const row = await store.get(t.id);
      assert.equal(row?.status, 'failed');
      assert.match(String(row?.error), /parked-task window|no human answered/);
    });

    it('a RESUMED task survives the reaper: provideInput resets the liveness clock', async () => {
      // Regression for the resume↔reaper collision. `requireInput` FREEZES
      // `lastHeartbeatAt` at the pre-park claim; a human then takes a while to
      // answer. If `provideInput` does not reset that clock, the resumed
      // `working` row carries a heartbeat older than the reaper's worker window
      // and the very next sweep force-fails it as "abandoned" — the human's
      // answer landing on a `failed` task, the exact bug the parked-exclusion was
      // built to prevent, reintroduced at the resume boundary.
      const store = await makeStore();
      const t = await store.create({ kind: 'k', input: {} });
      const lease = randomUUID();
      await store.claimNextPending(lease); // stamps lastHeartbeatAt at ~now
      await store.requireInput(t.id, lease); // parks, freezing that heartbeat

      // The human wait: age the frozen heartbeat past the window used below.
      await sleep(120);
      const resumed = await store.provideInput(t.id, { answer: 'late' });
      assert.equal(resumed.status, 'working');

      // Read-back: the resume moved the liveness clock forward off the frozen
      // pre-park value, not just the status.
      const afterResume = await store.get(t.id);
      assert.ok(
        afterResume?.lastHeartbeatAt != null &&
          Date.parse(afterResume.lastHeartbeatAt) >
            Date.parse(afterResume.createdAt),
        'provideInput advanced lastHeartbeatAt past creation',
      );

      // Reap immediately with a window (60ms) that sits BETWEEN the frozen
      // pre-park heartbeat (~120ms old) and the just-reset one (~0ms old). Uses
      // the reaper's default real-time `now`, so both stores' wall clocks agree.
      const result = await store.reapOrphans({
        staleAfterMs: 60,
        purgeTerminalAfterMs: HOUR_MS,
      });
      assert.equal(result.staleFailed, 0, 'the resumed task is NOT abandoned');

      const row = await store.get(t.id);
      assert.equal(row?.status, 'working', 'it stays live and re-claimable');
      const reclaim = await store.claimNextPending(randomUUID());
      assert.equal(reclaim?.descriptor.id, t.id);
      assert.deepEqual(reclaim?.input, { answer: 'late' });
    });
  });
}
