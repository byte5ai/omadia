/**
 * Epic #470 W1 — JobManager create/delete race (review medium finding).
 *
 * A DELETE that arrives AFTER `create` recorded the id in `#inflight` but BEFORE
 * `#provision` registered it in `#jobs` used to return false ('not found'); the
 * create then completed and left a live container for an id the caller believed
 * was deleted — a container nobody would reap. These tests pin the fix: the
 * in-flight create's container is torn down, not registered, and the create
 * caller is told its job was cancelled.
 *
 * The race is made deterministic by a fake engine whose `createJobContainer`
 * blocks on a gate the test resolves only AFTER the DELETE has returned.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { JobCancelledError, JobCapacityError, JobCleanupError, JobManager } from '../src/jobs.mjs';

const JOB_ID = '11111111-1111-4111-8111-111111111111';

/** A deferred promise the test resolves by hand. */
function deferred() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}

/** A fake engine whose createJobContainer blocks on `gate` until the test resolves it. */
function gatedEngine(gate) {
  const destroyed = [];
  let seq = 0;
  return {
    destroyed,
    async ping() {
      return { reachable: true, apiVersion: '1.47' };
    },
    async createJobContainer() {
      await gate.promise;
      seq += 1;
      return { containerId: `c-${seq}`, networkId: `n-${seq}`, volumeName: `v-${seq}`, imageDigest: 'sha256:x' };
    },
    async destroyJobContainer(container) {
      destroyed.push(container);
    },
    async streamLogs() {
      return { on() {}, pipe() {} };
    },
    async warmImages() {
      return [];
    },
  };
}

function fakePolicyClient() {
  return {
    async fetchJobPolicy(jobId) {
      return { jobId, image: 'ghcr.io/x/y@sha256:abc', env: {}, egressAllowlist: [] };
    },
  };
}

/** Let queued microtasks/immediates flush so #provision reaches the gated create. */
function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('JobManager — DELETE racing an in-flight create', () => {
  it('reaps the just-created container instead of leaking it, and cancels the create', async () => {
    const gate = deferred();
    const engine = gatedEngine(gate);
    const jm = new JobManager({ engine, policyClient: fakePolicyClient() });

    // 1) Start create — it blocks inside #provision at createJobContainer(gate).
    const createPromise = jm.create(JOB_ID, 180);
    await tick(); // ensure #provision is parked on the gate, id is in #inflight

    // 2) DELETE arrives BEFORE the container is registered. It returns immediately
    //    (marks the id cancelled) — no live job yet, nothing to reap synchronously.
    const destroyed = await jm.destroy(JOB_ID);
    assert.equal(destroyed, true, 'delete of an in-flight create is acknowledged');
    assert.equal(jm.size(), 0, 'no job is registered while the create is still cancelled');
    assert.equal(engine.destroyed.length, 0, 'container not created yet — nothing destroyed so far');

    // 3) Now let the create finish provisioning. #provision must see the
    //    cancellation, destroy the container it just created, and throw.
    gate.resolve();
    await assert.rejects(createPromise, (err) => {
      assert.ok(err instanceof JobCancelledError, `expected JobCancelledError, got ${err}`);
      assert.equal(err.code, 'daemon.job_cancelled');
      return true;
    });

    // 4) The container was reaped, and no ghost job remains.
    assert.equal(engine.destroyed.length, 1, 'the raced container is torn down, not leaked');
    assert.equal(jm.size(), 0, 'no live job for the deleted id');
  });

  it('does not leak the cancellation into a later create for the same id', async () => {
    const gate = deferred();
    const engine = gatedEngine(gate);
    const jm = new JobManager({ engine, policyClient: fakePolicyClient() });

    // First: race a create + delete (create is cancelled while parked on the gate).
    const first = jm.create(JOB_ID, 180);
    await tick();
    await jm.destroy(JOB_ID);
    gate.resolve(); // now the gate is open for this and every later create
    await assert.rejects(first, JobCancelledError);
    assert.equal(jm.size(), 0);

    // A brand-new create for the same id must succeed — the cancellation flag was
    // cleared in create()'s finally, so it is NOT wrongly torn down.
    const { record, created } = await jm.create(JOB_ID, 180);
    assert.equal(created, true);
    assert.equal(record.jobId, JOB_ID);
    assert.equal(jm.size(), 1, 'the later create registers a live job');
  });
});

/** A fake engine whose createJobContainer resolves immediately and whose
 *  destroyJobContainer is controlled by `destroyImpl` (default: succeed). */
function immediateEngine(destroyImpl) {
  let seq = 0;
  return {
    async ping() {
      return { reachable: true, apiVersion: '1.47' };
    },
    async createJobContainer() {
      seq += 1;
      return { containerId: `c-${seq}`, networkId: `n-${seq}`, volumeName: `v-${seq}`, imageDigest: 'sha256:x' };
    },
    async destroyJobContainer(container) {
      if (destroyImpl) return destroyImpl(container);
    },
    async streamLogs() {
      return { on() {}, pipe() {} };
    },
    async warmImages() {
      return [];
    },
  };
}

describe('JobManager — destroy tears down BEFORE forgetting the job', () => {
  it('keeps the job listed when engine teardown throws, and a retry succeeds once it recovers', async () => {
    let fail = true;
    const destroyed = [];
    const engine = immediateEngine((container) => {
      if (fail) throw new Error('docker cleanup blew up');
      destroyed.push(container);
    });
    const jm = new JobManager({ engine, policyClient: fakePolicyClient() });

    await jm.create(JOB_ID, 180);
    assert.equal(jm.size(), 1);

    // First DELETE: engine cleanup throws → the job is KEPT (its handle is the
    // only thing that can retry the cleanup), and the error names it as retryable.
    await assert.rejects(jm.destroy(JOB_ID), (err) => {
      assert.ok(err instanceof JobCleanupError, `expected JobCleanupError, got ${err}`);
      assert.equal(err.code, 'daemon.cleanup_failed');
      return true;
    });
    assert.equal(jm.size(), 1, 'the job is still tracked after a failed teardown');
    assert.equal(jm.get(JOB_ID)?.jobId, JOB_ID, 'the handle is retained for the retry');

    // Engine recovers; a second DELETE succeeds and now forgets the job.
    fail = false;
    const ok = await jm.destroy(JOB_ID);
    assert.equal(ok, true);
    assert.equal(jm.size(), 0, 'the job is gone only after cleanup is proven');
    assert.equal(destroyed.length, 1, 'the container was actually torn down');
  });
});

describe('JobManager — admission bounds', () => {
  it('refuses a NEW job past the live-job cap with a 429-mapped error, creating nothing', async () => {
    const engine = immediateEngine();
    const jm = new JobManager({ engine, policyClient: fakePolicyClient(), maxLiveJobs: 2, maxInflight: 2 });

    await jm.create('11111111-1111-4111-8111-000000000001', 180);
    await jm.create('11111111-1111-4111-8111-000000000002', 180);
    assert.equal(jm.size(), 2);

    await assert.rejects(jm.create('11111111-1111-4111-8111-000000000003', 180), (err) => {
      assert.ok(err instanceof JobCapacityError, `expected JobCapacityError, got ${err}`);
      assert.equal(err.code, 'daemon.at_capacity');
      return true;
    });
    assert.equal(jm.size(), 2, 'no job was created past the cap');

    // An idempotent re-attach to an EXISTING job is still allowed at capacity.
    const { created } = await jm.create('11111111-1111-4111-8111-000000000001', 180);
    assert.equal(created, false);
  });

  it('refuses past the smaller in-flight cap while creates are parked', async () => {
    const gate = deferred();
    const engine = gatedEngine(gate);
    const jm = new JobManager({ engine, policyClient: fakePolicyClient(), maxLiveJobs: 8, maxInflight: 2 });

    // Two creates park on the gate — both in flight, none live yet.
    const p1 = jm.create('11111111-1111-4111-8111-00000000000a', 180);
    const p2 = jm.create('11111111-1111-4111-8111-00000000000b', 180);
    await tick();

    // A third NEW create trips the in-flight cap (2) even though no job is live.
    await assert.rejects(jm.create('11111111-1111-4111-8111-00000000000c', 180), (err) => {
      assert.ok(err instanceof JobCapacityError);
      assert.equal(err.code, 'daemon.too_many_inflight');
      return true;
    });

    gate.resolve();
    await Promise.all([p1, p2]);
    assert.equal(jm.size(), 2);
  });
});

describe('JobManager — create racing an in-progress destroy', () => {
  it('refuses a create for a job whose container is still being torn down', async () => {
    let release;
    const gate = new Promise((r) => (release = r));
    // The DELETE is mid-flight: the record still exists, but is doomed.
    const engine = immediateEngine(async () => {
      await gate;
    });
    const jm = new JobManager({ engine, policyClient: fakePolicyClient() });
    await jm.create(JOB_ID, 60);

    const deleting = jm.destroy(JOB_ID);
    // Handing back the doomed record here would answer with a container that is
    // about to disappear.
    await assert.rejects(() => jm.create(JOB_ID, 60), /deleted while it was being created|cancelled/i);

    release();
    assert.equal(await deleting, true);
    // Once the teardown is proven, the id is free again.
    const again = await jm.create(JOB_ID, 60);
    assert.equal(again.created, true);
  });
});

describe('JobManager — a failed teardown on the cancel path keeps the handle', () => {
  it('registers the container when destroying a cancelled create fails', async () => {
    let releaseCreate;
    const createGate = new Promise((r) => (releaseCreate = r));
    let seq = 0;
    const engine = {
      async ping() {
        return { reachable: true, apiVersion: '1.47' };
      },
      async createJobContainer() {
        await createGate; // the DELETE lands while we are provisioning
        seq += 1;
        return { containerId: `c-${seq}`, networkId: `n-${seq}`, volumeName: `v-${seq}`, imageDigest: 'sha256:x' };
      },
      async destroyJobContainer() {
        throw new Error('docker is down');
      },
      async streamLogs() {
        return { on() {}, pipe() {} };
      },
      async warmImages() {
        return [];
      },
    };
    const jm = new JobManager({ engine, policyClient: fakePolicyClient() });

    const creating = jm.create(JOB_ID, 60);
    await Promise.resolve();
    const deleting = jm.destroy(JOB_ID); // cancels the in-flight create
    releaseCreate();

    // The container exists but could not be torn down, so the create fails with
    // a cleanup error — and the job stays tracked so cleanup can be retried.
    await assert.rejects(() => creating, /teardown failed|cleanup/i);
    await deleting.catch(() => {});
    assert.equal(jm.list().length, 1, 'the container is still tracked, not leaked');
  });
});

describe('JobManager — DELETE of an in-flight create waits for the outcome', () => {
  it('reports failure (not success) when the cancel teardown fails', async () => {
    let releaseCreate;
    const createGate = new Promise((r) => (releaseCreate = r));
    const engine = {
      async ping() {
        return { reachable: true, apiVersion: '1.47' };
      },
      async createJobContainer() {
        await createGate;
        return { containerId: 'c-1', networkId: 'n-1', volumeName: 'v-1', imageDigest: 'sha256:x' };
      },
      async destroyJobContainer() {
        throw new Error('docker is down');
      },
      async streamLogs() {
        return { on() {}, pipe() {} };
      },
      async warmImages() {
        return [];
      },
    };
    const jm = new JobManager({ engine, policyClient: fakePolicyClient() });

    const creating = jm.create(JOB_ID, 60);
    await Promise.resolve();
    const deleting = jm.destroy(JOB_ID);
    releaseCreate();

    await assert.rejects(() => creating, /teardown failed|cleanup/i);
    // Answering `true` here would tell the caller the job is gone while its
    // container is still alive and tracked.
    await assert.rejects(() => deleting, /teardown failed|cleanup/i);
    assert.equal(jm.list().length, 1, 'the surviving container is still tracked for a retry');
  });

  it('reports success once the cancelled create tore its container down', async () => {
    let releaseCreate;
    const createGate = new Promise((r) => (releaseCreate = r));
    const engine = immediateEngine();
    const slowCreate = { ...engine, async createJobContainer(args) {
      await createGate;
      return engine.createJobContainer(args);
    } };
    const jm = new JobManager({ engine: slowCreate, policyClient: fakePolicyClient() });

    const creating = jm.create(JOB_ID, 60);
    await Promise.resolve();
    const deleting = jm.destroy(JOB_ID);
    releaseCreate();

    await assert.rejects(() => creating, /deleted while it was being created|cancelled/i);
    assert.equal(await deleting, true);
    assert.equal(jm.list().length, 0, 'nothing is left behind');
  });
});
