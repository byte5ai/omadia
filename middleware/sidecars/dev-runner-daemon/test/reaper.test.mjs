/**
 * Epic #470 W1 — lease reaper, orphan sweep, boot-time state rebuild (spec §7).
 *
 * These pin the gap every prior audit noted: `leaseExpiresAt` was recorded and
 * renewed but never ENFORCED, so a wedged or compromised middleware could pin
 * containers forever. The reaper makes the daemon self-authoritative for
 * containers. What is proven here:
 *
 *   - a live job past its lease is torn down by the periodic sweep, through the
 *     EXACT deduplicated path a DELETE uses (`JobManager.destroy`) — no second
 *     teardown; a failed teardown retains the handle for the next sweep;
 *   - boot rebuild re-adopts labelled containers (a restart does not orphan a
 *     live job) and reaps the ones already past their lease (`boot_stale`);
 *   - the orphan sweep clears labelled resources with no tracked job, including
 *     the partial network/volume a failed create could not roll back, while never
 *     touching a job that is live OR mid-create (hard-won lesson (a));
 *   - the sweep is single-flighted, survives an engine error, and its timer is
 *     unref'd + stoppable so the suite never hangs (lesson (d)).
 *
 * Assertions check BOTH the count and the reason string so a reap is observable.
 */

import { strict as assert } from 'node:assert';
import { Readable } from 'node:stream';
import { describe, it } from 'node:test';

import { JobCleanupError, JobManager } from '../src/jobs.mjs';
import { createReaper, isLeaseExpired, resolveSweepIntervalMs } from '../src/reaper.mjs';

const JOB_A = '11111111-1111-4111-8111-111111111111';
const JOB_B = '22222222-2222-4222-8222-222222222222';
const JOB_C = '33333333-3333-4333-8333-333333333333';

/** A mutable clock shared by the JobManager and the reaper so lease math lines up. */
function mutableClock(start = 0) {
  return { t: start, now() { return this.t; } };
}

/** A deferred promise the test resolves by hand. */
function deferred() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}

/** A capturing logger so we can assert the reap reasons are observable. */
function capturingLogger() {
  const infos = [];
  const warns = [];
  return {
    infos,
    warns,
    info: (m) => infos.push(m),
    warn: (m) => warns.push(m),
    /** @param {string} needle */
    reaped(needle) {
      return infos.filter((m) => m.includes('reaped') && m.includes(needle));
    },
  };
}

function fakePolicyClient() {
  return {
    async fetchJobPolicy(jobId) {
      return { jobId, image: `ghcr.io/x/y@sha256:${'a'.repeat(64)}`, env: {}, egressAllowlist: [] };
    },
  };
}

/**
 * A container engine fake backed by a jobId-keyed store that models the label set
 * on dind. `seed` is `{ [jobId]: { hasContainer, hasNetwork, hasVolume, lease } }`.
 * `destroyJobContainer` REMOVES from the store, so a re-list after a reap does not
 * return the resource — exactly what real docker does (a static fake would double
 * report and hide idempotency bugs). Names are the deterministic `omadia-job-<id>`.
 */
function fakeEngine(seed = {}, opts = {}) {
  const jobs = new Map(Object.entries(seed).map(([id, j]) => [id, { ...j }]));
  const calls = { list: 0, destroyed: [] };
  /** @param {{ containerId?: string, networkId?: string, volumeName?: string }} h */
  const jobIdOf = (h) => {
    if (h.volumeName?.startsWith('omadia-job-')) return h.volumeName.slice('omadia-job-'.length);
    if (h.networkId?.startsWith('omadia-job-')) return h.networkId.slice('omadia-job-'.length);
    if (h.containerId?.startsWith('c-')) return h.containerId.slice(2);
    return '';
  };
  return {
    calls,
    /** Introduce a resource AFTER construction — a leak that appears while the
     *  daemon is already running, which is the only way a labelled container can
     *  be an orphan: the boot rebuild adopts everything it can see. */
    seed(jobId, spec) {
      jobs.set(jobId, { ...spec });
    },
    async ping() {
      return { reachable: true, apiVersion: '1.47' };
    },
    async createJobContainer({ jobId }) {
      if (opts.createGate) await opts.createGate.promise;
      return { containerId: `c-${jobId}`, networkId: `omadia-job-${jobId}`, volumeName: `omadia-job-${jobId}`, imageDigest: 'sha256:x' };
    },
    async destroyJobContainer(container) {
      if (opts.destroyGate) await opts.destroyGate.promise;
      if (opts.destroyFail?.()) throw new Error('docker cleanup blew up');
      calls.destroyed.push(container);
      jobs.delete(jobIdOf(container)); // model real removal so a re-list won't return it
    },
    async streamLogs() {
      return Readable.from(['x']);
    },
    async warmImages() {
      return [];
    },
    async listManagedResources() {
      calls.list += 1;
      if (opts.listGate) await opts.listGate.promise;
      if (opts.listThrows?.()) throw new Error('engine unreachable');
      const inv = { containers: [], networks: [], volumes: [] };
      for (const [jobId, j] of jobs) {
        if (j.hasContainer) {
          inv.containers.push({
            jobId,
            containerId: `c-${jobId}`,
            leaseExpiresAt: j.lease ?? '',
            imageDigest: j.imageDigest ?? '',
            // Real docker always reports a state; a fake that omits it hides the
            // difference between a live job and a corpse.
            running: j.running ?? true,
            // Real docker reports the container's creation time; the daemon's
            // absolute lifetime is measured from it.
            createdAtMs: j.createdAtMs ?? 0,
          });
        }
        if (j.hasNetwork) inv.networks.push({ jobId, id: `omadia-job-${jobId}` });
        if (j.hasVolume) inv.volumes.push({ jobId, id: `omadia-job-${jobId}` });
      }
      return inv;
    },
  };
}

/** Poll `pred` until true or the timeout trips (so a broken timer fails LOUD, not by hanging). */
async function waitUntil(pred, timeoutMs = 2000) {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

const isoAt = (ms) => new Date(ms).toISOString();

describe('reaper — lease expiry enforcement', () => {
  it('reaps a live job past its lease through the SAME deduplicated path as DELETE', async () => {
    const clock = mutableClock(0);
    const engine = fakeEngine();
    const logger = capturingLogger();
    const jm = new JobManager({ engine, policyClient: fakePolicyClient(), clock });
    const reaper = createReaper({ jobManager: jm, engine, clock, logger });

    const { record } = await jm.create(JOB_A, 180); // lease = 180_000 ms
    assert.equal(jm.size(), 1);

    // Prove the reaper reuses JobManager.destroy (the DELETE path), not a parallel
    // teardown: spy that delegates to the real method.
    const destroyCalls = [];
    const origDestroy = jm.destroy.bind(jm);
    jm.destroy = (id) => {
      destroyCalls.push(id);
      return origDestroy(id);
    };

    clock.t = 200_000; // past the 180 s lease
    await reaper.sweep();

    assert.deepEqual(destroyCalls, [JOB_A], 'the reaper tore the job down via JobManager.destroy');
    assert.equal(jm.size(), 0, 'the expired job is gone from the registry');
    assert.equal(engine.calls.destroyed.length, 1, 'the container was actually removed');
    assert.equal(engine.calls.destroyed[0].containerId, record.container.containerId, 'the tracked handle was torn down');
    assert.equal(logger.reaped('lease_expired').length, 1, 'the reap is logged with its reason');
  });

  it('leaves a job whose lease is still valid untouched', async () => {
    const clock = mutableClock(0);
    const engine = fakeEngine();
    const jm = new JobManager({ engine, policyClient: fakePolicyClient(), clock });
    const reaper = createReaper({ jobManager: jm, engine, clock, logger: capturingLogger() });

    await jm.create(JOB_A, 180);
    clock.t = 179_000; // still inside the lease
    await reaper.sweep();

    assert.equal(jm.size(), 1, 'a valid lease is never reaped');
    assert.equal(engine.calls.destroyed.length, 0);
  });

  it('retains the handle when teardown fails, and reaps on a later sweep once the engine recovers', async () => {
    const clock = mutableClock(0);
    let down = true;
    const engine = fakeEngine({}, { destroyFail: () => down });
    const logger = capturingLogger();
    const jm = new JobManager({ engine, policyClient: fakePolicyClient(), clock });
    const reaper = createReaper({ jobManager: jm, engine, clock, logger });

    await jm.create(JOB_A, 180);
    clock.t = 200_000;

    // First sweep: teardown throws → the job is KEPT (its handle is the only thing
    // that can retry cleanup), and the failure is surfaced as a warning.
    await reaper.sweep();
    assert.equal(jm.size(), 1, 'a failed teardown retains the job for the next sweep');
    assert.ok(
      logger.warns.some((m) => m.includes(JOB_A) && /retain/i.test(m)),
      'the failure is surfaced, not swallowed',
    );
    assert.equal(logger.reaped('lease_expired').length, 0, 'nothing is logged as reaped while it survives');

    // Engine recovers; the next sweep finishes the job.
    down = false;
    await reaper.sweep();
    assert.equal(jm.size(), 0, 'the job is gone only once cleanup is proven');
    assert.equal(logger.reaped('lease_expired').length, 1);
  });
});

describe('reaper — boot-time state rebuild', () => {
  it('re-adopts a labelled live container so a daemon restart does not orphan it', async () => {
    const clock = mutableClock(100_000);
    // A container with a lease well in the future, plus its per-job network+volume.
    const engine = fakeEngine({
      [JOB_A]: { hasContainer: true, hasNetwork: true, hasVolume: true, lease: isoAt(400_000) },
    });
    const logger = capturingLogger();
    const jm = new JobManager({ engine, policyClient: fakePolicyClient(), clock });
    const reaper = createReaper({ jobManager: jm, engine, clock, logger });

    await reaper.rebuild();

    assert.equal(jm.size(), 1, 'the live container was re-adopted, not orphaned');
    const adopted = jm.get(JOB_A);
    assert.ok(adopted, 'the job is in the registry');
    assert.equal(adopted.container.containerId, `c-${JOB_A}`, 'the real container id is adopted');
    assert.equal(adopted.container.volumeName, `omadia-job-${JOB_A}`, 'the deterministic volume name is reconstructed');
    assert.equal(engine.calls.destroyed.length, 0, 'a live re-adopted job is not reaped');
  });

  it('reaps an EXITED container as boot_stale, whatever its lease says', async () => {
    const clock = mutableClock(500_000);
    const engine = fakeEngine({
      // Not running: its runner exited and nobody is coming back. That, not the
      // lease label, is the honest boot-time staleness signal.
      [JOB_A]: { hasContainer: true, hasNetwork: true, hasVolume: true, lease: isoAt(900_000), running: false },
    });
    const logger = capturingLogger();
    const jm = new JobManager({ engine, policyClient: fakePolicyClient(), clock });
    const reaper = createReaper({ jobManager: jm, engine, clock, logger });

    await reaper.rebuild();

    assert.equal(jm.size(), 0, 'the corpse was reaped even though its lease is in the future');
    assert.equal(engine.calls.destroyed.length, 1, 'its container+network+volume were torn down');
    assert.equal(logger.reaped('boot_stale').length, 1, 'reaped with the boot_stale reason');
  });

  it('grants a RUNNING container a grace window instead of reaping it on a stale label', async () => {
    // THE BUG THIS GUARDS: the lease label is frozen at create time, but a live
    // job's lease is renewed in memory — and that memory dies with the daemon.
    // A job renewed for an hour looks, from its label alone, an hour overdue.
    // Reaping on the label would kill exactly the jobs the rebuild preserves.
    const clock = mutableClock(500_000);
    const engine = fakeEngine({
      [JOB_A]: { hasContainer: true, hasNetwork: true, hasVolume: true, lease: isoAt(400_000), running: true },
    });
    const logger = capturingLogger();
    const jm = new JobManager({ engine, policyClient: fakePolicyClient(), clock });
    const reaper = createReaper({ jobManager: jm, engine, clock, logger, intervalMs: 30_000 });

    await reaper.rebuild();

    assert.equal(jm.size(), 1, 'the live job survives its stale label');
    assert.equal(engine.calls.destroyed.length, 0, 'nothing was torn down');
    assert.equal(logger.reaped('boot_stale').length, 0);

    // The middleware never re-asserts the lease, so the ordinary sweep reaps it
    // one grace window later — through the same path, as lease_expired.
    clock.t += 30_001;
    await reaper.sweep();
    assert.equal(jm.size(), 0, 'an un-renewed job still dies');
    assert.equal(logger.reaped('lease_expired').length, 1);
  });

  it('grants a running container with NO lease label the same grace, then reaps it', async () => {
    const clock = mutableClock(500_000);
    const engine = fakeEngine({
      [JOB_A]: { hasContainer: true, hasNetwork: true, hasVolume: true, lease: '', running: true },
    });
    const logger = capturingLogger();
    const jm = new JobManager({ engine, policyClient: fakePolicyClient(), clock });
    const reaper = createReaper({ jobManager: jm, engine, clock, logger, intervalMs: 30_000 });

    await reaper.rebuild();
    assert.equal(jm.size(), 1, 'a live container is not killed for a missing label alone');

    clock.t += 30_001;
    await reaper.sweep();
    assert.equal(jm.size(), 0, 'a container we cannot prove is leased is not kept forever');
    assert.equal(logger.reaped('lease_expired').length, 1);
  });
});

describe('reaper — orphan sweep', () => {
  it('removes a partial network+volume a failed create left behind (no container) as orphan', async () => {
    const clock = mutableClock(0);
    // No container — exactly what a create that failed AFTER the network/volume but
    // could not roll them back leaves: labelled, deterministically named, dangling.
    const engine = fakeEngine({
      [JOB_A]: { hasContainer: false, hasNetwork: true, hasVolume: true },
    });
    const logger = capturingLogger();
    const jm = new JobManager({ engine, policyClient: fakePolicyClient(), clock });
    const reaper = createReaper({ jobManager: jm, engine, clock, logger });

    // start() always rebuilds before it sweeps, and the orphan sweep refuses to
    // run on a registry no rebuild ever populated — an empty registry makes
    // every live container look like a leak.
    await reaper.rebuild();
    await reaper.sweep();

    assert.equal(engine.calls.destroyed.length, 1, 'the dangling pair was reaped in one teardown');
    const handle = engine.calls.destroyed[0];
    assert.equal(handle.containerId, '', 'there was no container to remove');
    assert.equal(handle.networkId, `omadia-job-${JOB_A}`, 'the orphan network is named');
    assert.equal(handle.volumeName, `omadia-job-${JOB_A}`, 'the orphan volume is named');
    assert.equal(logger.reaped('orphan').length, 1);
  });

  it('removes a fully-leaked container+network+volume group in one teardown', async () => {
    const clock = mutableClock(0);
    const engine = fakeEngine({});
    const logger = capturingLogger();
    const jm = new JobManager({ engine, policyClient: fakePolicyClient(), clock });
    const reaper = createReaper({ jobManager: jm, engine, clock, logger });
    // The rebuild sees an empty engine, so the registry is trustworthy. THEN a
    // labelled group appears that the registry never knew — created out of band,
    // or left by a daemon that died mid-create. That is what an orphan is: after
    // a successful rebuild, anything untracked is a leak.
    await reaper.rebuild();
    engine.seed(JOB_A, { hasContainer: true, hasNetwork: true, hasVolume: true, lease: isoAt(999_999_999) });

    await reaper.sweep();

    assert.equal(engine.calls.destroyed.length, 1);
    const handle = engine.calls.destroyed[0];
    assert.equal(handle.containerId, `c-${JOB_A}`);
    assert.equal(handle.networkId, `omadia-job-${JOB_A}`);
    assert.equal(handle.volumeName, `omadia-job-${JOB_A}`);
    assert.equal(logger.reaped('orphan').length, 1);
  });

  it('never reaps a resource whose job is still tracked (live)', async () => {
    const clock = mutableClock(0);
    const engine = fakeEngine({
      [JOB_A]: { hasContainer: true, hasNetwork: true, hasVolume: true, lease: isoAt(999_999_999) },
    });
    const jm = new JobManager({ engine, policyClient: fakePolicyClient(), clock });
    const reaper = createReaper({ jobManager: jm, engine, clock, logger: capturingLogger() });

    // Adopt A into the registry — now it is a live job, not an orphan.
    await reaper.rebuild();
    assert.equal(jm.size(), 1);
    engine.calls.destroyed.length = 0; // ignore anything rebuild did

    // start() always rebuilds before it sweeps, and the orphan sweep refuses to
    // run on a registry no rebuild ever populated — an empty registry makes
    // every live container look like a leak.
    await reaper.rebuild();
    await reaper.sweep();
    assert.equal(engine.calls.destroyed.length, 0, 'a tracked job is never swept as an orphan');
    assert.equal(jm.size(), 1);
  });

  it('never reaps a resource whose job is mid-create (in-flight) — lesson (a)', async () => {
    const clock = mutableClock(0);
    const createGate = deferred();
    // The engine already shows A's network (create got that far), but the create
    // itself is parked, so A sits in #inflight, not yet #jobs.
    const engine = fakeEngine({ [JOB_A]: { hasNetwork: true, hasVolume: true } }, { createGate });
    const jm = new JobManager({ engine, policyClient: fakePolicyClient(), clock });
    const reaper = createReaper({ jobManager: jm, engine, clock, logger: capturingLogger() });

    const creating = jm.create(JOB_A, 180); // parks inside #provision on the gate
    await new Promise((r) => setImmediate(r)); // let #provision reach the gate, id now in #inflight

    // start() always rebuilds before it sweeps, and the orphan sweep refuses to
    // run on a registry no rebuild ever populated — an empty registry makes
    // every live container look like a leak.
    await reaper.rebuild();
    await reaper.sweep();
    assert.equal(engine.calls.destroyed.length, 0, 'a mid-create job’s resources are never swept');

    createGate.resolve();
    await creating;
    assert.equal(jm.size(), 1, 'the create completed normally');
  });
});

describe('reaper — scheduling + resilience', () => {
  it('never runs two passes concurrently (single-flight)', async () => {
    const clock = mutableClock(0);
    const listGate = deferred();
    const opts = {};
    const engine = fakeEngine({}, opts);
    const jm = new JobManager({ engine, policyClient: fakePolicyClient(), clock });
    const reaper = createReaper({ jobManager: jm, engine, clock, logger: capturingLogger() });

    // The orphan sweep refuses to run before a successful rebuild, so rebuild
    // first — exactly as start() does — and only then arm the gate.
    await reaper.rebuild();
    const listsAfterRebuild = engine.calls.list;
    opts.listGate = listGate;

    const p1 = reaper.sweep(); // parks inside reapOrphans on the list gate
    const p2 = reaper.sweep(); // must see a pass in flight and no-op
    await new Promise((r) => setImmediate(r)); // let p1 reach the gated engine list
    assert.equal(engine.calls.list, listsAfterRebuild + 1, 'the second sweep did not start its own pass');

    listGate.resolve();
    await Promise.all([p1, p2]);
    assert.equal(engine.calls.list, listsAfterRebuild + 1, 'still exactly one engine list across both sweeps');
  });

  it('survives an engine error and resolves (retries next tick)', async () => {
    const clock = mutableClock(0);
    let broken = false;
    const engine = fakeEngine({}, { listThrows: () => broken });
    const logger = capturingLogger();
    const jm = new JobManager({ engine, policyClient: fakePolicyClient(), clock });
    const reaper = createReaper({ jobManager: jm, engine, clock, logger });

    // Rebuild first (start() does), so the sweep is allowed to touch orphans at
    // all. The leak appears afterwards, then the engine breaks underneath it.
    await reaper.rebuild();
    engine.seed(JOB_A, { hasNetwork: true, hasVolume: true });
    broken = true;

    // A throwing engine must not reject out of sweep() — it logs and returns.
    await reaper.sweep();
    assert.ok(logger.warns.some((m) => /failed; retrying next tick/.test(m)), 'the engine error is logged');
    assert.equal(engine.calls.destroyed.length, 0);

    // Next tick the engine is back; the orphan is cleared.
    broken = false;
    await reaper.sweep();
    assert.equal(engine.calls.destroyed.length, 1, 'the pass retried and reaped the orphan');
  });

  it('start() rebuilds then a PERIODIC sweep reaps a job that expires afterwards; stop() halts it', async () => {
    const clock = mutableClock(0);
    const engine = fakeEngine();
    const logger = capturingLogger();
    const jm = new JobManager({ engine, policyClient: fakePolicyClient(), clock });
    const reaper = createReaper({ jobManager: jm, engine, clock, intervalMs: 15, logger });

    await reaper.start(); // boot rebuild (empty), then the timer is armed
    try {
      // A job created AND expired AFTER start can only be reaped by the periodic
      // timer — proving the sweep is not a one-shot boot action.
      await jm.create(JOB_A, 180);
      clock.t = 200_000;
      await waitUntil(() => engine.calls.destroyed.length >= 1);
      assert.equal(logger.reaped('lease_expired').length, 1, 'the timer-driven sweep reaped the expired job');
    } finally {
      reaper.stop();
    }

    // After stop the timer fires no more: expire a second job and confirm no reap.
    const before = engine.calls.destroyed.length;
    await jm.create(JOB_B, 180);
    clock.t = 400_000;
    await new Promise((r) => setTimeout(r, 60)); // several would-be intervals
    assert.equal(engine.calls.destroyed.length, before, 'stop() halted the periodic sweep');
  });
});

describe('reaper — pure helpers', () => {
  it('isLeaseExpired: at/after now, or missing/unparseable, is expired', () => {
    assert.equal(isLeaseExpired(isoAt(1000), 2000), true, 'past lease is expired');
    assert.equal(isLeaseExpired(isoAt(2000), 2000), true, 'exactly now is expired (inclusive)');
    assert.equal(isLeaseExpired(isoAt(3000), 2000), false, 'future lease is valid');
    assert.equal(isLeaseExpired('', 2000), true, 'a missing lease label is treated as expired');
    assert.equal(isLeaseExpired('not-a-date', 2000), true, 'an unparseable lease is treated as expired');
  });

  it('resolveSweepIntervalMs: default, floor, and a valid override', () => {
    assert.equal(resolveSweepIntervalMs({}), 30_000, 'unset → default');
    assert.equal(resolveSweepIntervalMs({ DEV_RUNNER_SWEEP_INTERVAL_MS: '0' }), 30_000, 'below floor → default');
    assert.equal(resolveSweepIntervalMs({ DEV_RUNNER_SWEEP_INTERVAL_MS: 'abc' }), 30_000, 'non-numeric → default');
    assert.equal(resolveSweepIntervalMs({ DEV_RUNNER_SWEEP_INTERVAL_MS: '5000' }), 5000, 'a valid override is honoured');
  });
});

describe('reaper — the daemon owns the container lifetime, not the middleware', () => {
  it('reaps a job past its hard deadline no matter how often its lease is renewed', async () => {
    const clock = mutableClock(0);
    const engine = fakeEngine({});
    const logger = capturingLogger();
    const jm = new JobManager({
      engine,
      policyClient: fakePolicyClient(),
      clock,
      maxJobLifetimeMs: 60_000,
    });
    const reaper = createReaper({ jobManager: jm, engine, clock, logger, intervalMs: 1_000 });
    await jm.create(JOB_A, 30);

    // The middleware behaves exactly as a compromised one would: renew forever.
    for (let t = 0; t < 60_000; t += 10_000) {
      clock.t = t;
      jm.renew(JOB_A, 30);
      await reaper.sweep();
      assert.equal(jm.size(), 1, `job still alive within its lifetime (t=${t})`);
    }

    // Past the deadline the renewal cannot save it: a lease says "still
    // working", it can never say "run forever".
    clock.t = 60_001;
    jm.renew(JOB_A, 3600);
    await reaper.sweep();
    assert.equal(jm.size(), 0, 'the container dies at the daemon-owned deadline');
    assert.equal(logger.reaped('lifetime_exceeded').length, 1);
  });

  it('retries a boot_stale teardown the engine refused, sweep after sweep', async () => {
    const clock = mutableClock(500_000);
    let refuse = true;
    const engine = fakeEngine(
      { [JOB_A]: { hasContainer: true, hasNetwork: true, hasVolume: true, lease: isoAt(900_000), running: false } },
      { destroyFail: () => refuse },
    );
    const logger = capturingLogger();
    const jm = new JobManager({ engine, policyClient: fakePolicyClient(), clock });
    const reaper = createReaper({ jobManager: jm, engine, clock, logger, intervalMs: 1_000 });

    await reaper.rebuild();
    assert.equal(jm.size(), 1, 'the corpse is retained — its handle is the only way to retry');

    // Its graced lease is in the future, so nothing but an explicit retry would
    // ever look at it again.
    refuse = false;
    clock.t += 1;
    await reaper.sweep();
    assert.equal(jm.size(), 0, 'the retry tore it down once the engine recovered');
    assert.equal(logger.reaped('boot_stale').length, 1);
  });
});

describe('reaper — a failed boot rebuild must never let the sweep eat live jobs', () => {
  it('sweeps nothing until a rebuild has succeeded, then adopts instead of orphaning', async () => {
    const clock = mutableClock(0);
    let listFails = true;
    const engine = fakeEngine({
      [JOB_A]: { hasContainer: true, hasNetwork: true, hasVolume: true, lease: isoAt(600_000), running: true },
    });
    const realList = engine.listManagedResources;
    engine.listManagedResources = async () => {
      if (listFails) throw new Error('dind is not up yet');
      return realList();
    };
    const logger = capturingLogger();
    const jm = new JobManager({ engine, policyClient: fakePolicyClient(), clock });
    const reaper = createReaper({ jobManager: jm, engine, clock, logger, intervalMs: 1_000 });

    // The rebuild fails: the registry is empty. A sweep now would see every
    // labelled container as an unclaimed orphan and destroy the live job.
    await reaper.rebuild().catch(() => {});
    assert.equal(jm.size(), 0, 'nothing adopted — the listing failed');

    // dind recovers, but the registry is STILL empty. A sweep now must not treat
    // the live container as an orphan just because nobody adopted it yet.
    listFails = false;
    await reaper.sweep();
    assert.equal(engine.calls.destroyed.length, 0, 'the live container was NOT orphan-swept');
    await reaper.rebuild();
    assert.equal(jm.size(), 1, 'the live job is adopted, not destroyed');
    assert.equal(engine.calls.destroyed.length, 0);
  });

  it('abandons a hung pass so the loop keeps enforcing leases', async () => {
    const clock = mutableClock(0);
    const engine = fakeEngine({});
    engine.listManagedResources = () => new Promise(() => {}); // never settles
    const logger = capturingLogger();
    const jm = new JobManager({ engine, policyClient: fakePolicyClient(), clock });
    const reaper = createReaper({ jobManager: jm, engine, clock, logger, intervalMs: 1_000, passTimeoutMs: 20 });

    // Without a deadline the single-flight guard stays held forever and every
    // later sweep returns immediately — the loop looks alive and does nothing.
    // start() always rebuilds before it sweeps; the orphan sweep refuses to run
    // on an unrebuilt registry, so a bare sweep() would be a no-op.
    await reaper.rebuild();
    await reaper.sweep();
    engine.listManagedResources = async () => ({ containers: [], networks: [], volumes: [] });
    await reaper.sweep(); // must actually run, not be blocked by the hung pass
    assert.ok(logger.warns.some((m) => /exceeded 20ms/.test(m)), 'the hung pass was abandoned and logged');
  });
});

describe('reaper — restarting the daemon does not reset a container lifetime', () => {
  it('measures the hard deadline from the container birth, not from adoption', async () => {
    // The container was born at t=0 and the lifetime is 60s. The daemon restarts
    // at t=90_000 — long past the deadline. Adoption must NOT hand it a fresh
    // lifetime: otherwise a middleware that can restart the daemon owns an
    // immortal container and `lifetime_exceeded` means nothing.
    const clock = mutableClock(90_000);
    const engine = fakeEngine({
      [JOB_A]: {
        hasContainer: true,
        hasNetwork: true,
        hasVolume: true,
        lease: isoAt(999_999_999),
        running: true,
        createdAtMs: 0,
      },
    });
    const logger = capturingLogger();
    const jm = new JobManager({ engine, policyClient: fakePolicyClient(), clock, maxJobLifetimeMs: 60_000 });
    const reaper = createReaper({ jobManager: jm, engine, clock, logger, intervalMs: 1_000 });

    await reaper.rebuild();
    assert.equal(jm.size(), 1, 'adopted, so its teardown goes through the normal path');

    await reaper.sweep();
    assert.equal(jm.size(), 0, 'the container is past its lifetime and dies');
    assert.equal(logger.reaped('lifetime_exceeded').length, 1);
  });
});
