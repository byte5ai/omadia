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

import { JobCancelledError, JobManager } from '../src/jobs.mjs';

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
