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
import { Readable } from 'node:stream';
import { describe, it } from 'node:test';

import Docker from 'dockerode';

import { SpecRejectedError } from '../src/clamp.mjs';
import { createDockerEngine, JobCancelledError, JobCapacityError, JobCleanupError, JobManager } from '../src/jobs.mjs';

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

    // 2) DELETE arrives BEFORE the container is registered. It marks the id
    //    cancelled and then WAITS for the create to settle: answering earlier
    //    would claim the job is gone while its teardown could still fail.
    const destroyPromise = jm.destroy(JOB_ID);
    await tick();
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
    assert.equal(await destroyPromise, true, 'the delete is acknowledged once the teardown is proven');

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
    const deleting = jm.destroy(JOB_ID); // awaits the create's outcome
    gate.resolve(); // now the gate is open for this and every later create
    await assert.rejects(first, JobCancelledError);
    assert.equal(await deleting, true);
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

describe('JobManager — concurrent DELETEs for the same job', () => {
  it('runs one teardown and never deletes a job a later create registered', async () => {
    const gate = deferred();
    let destroys = 0;
    const base = immediateEngine();
    const engine = {
      ...base,
      async destroyJobContainer(container) {
        destroys += 1;
        await gate.promise; // both DELETEs are now inside destroy()
        return base.destroyJobContainer(container);
      },
    };
    const jm = new JobManager({ engine, policyClient: fakePolicyClient() });
    await jm.create(JOB_ID, 60);

    const first = jm.destroy(JOB_ID);
    const second = jm.destroy(JOB_ID); // must join the first, not start its own
    gate.resolve();
    assert.equal(await first, true);
    assert.equal(await second, true);
    assert.equal(destroys, 1, 'the container is torn down exactly once');

    // A fresh create for the same id must survive: a late-returning DELETE that
    // deleted unconditionally would drop this record and leak its container.
    const again = await jm.create(JOB_ID, 60);
    assert.equal(again.created, true);
    assert.equal(jm.size(), 1, 'the new job is still tracked');
  });
});

// --------------------------------------------------------------------------
// createDockerEngine — the real dockerode lifecycle behind the seam.
// Driven against a FAKE dockerode (injected via `docker`) so the orchestration
// (network+volume+container+start, rollback, verified idempotent teardown) is
// asserted without a running engine. A real-docker check lives at the bottom.
// --------------------------------------------------------------------------

const DIGEST = 'sha256:2222222222222222222222222222222222222222222222222222222222222222';
const DIGEST_IMAGE = `ghcr.io/byte5ai/omadia-dev-runner@${DIGEST}`;

/** @returns {import('../src/policyClient.mjs').DerivedJobPolicy} */
function enginePolicy(image = DIGEST_IMAGE) {
  return { jobId: JOB_ID, image, env: { OMADIA_JOB_ID: JOB_ID }, egressAllowlist: [] };
}

/** A 404 dockerode error (the "already gone" signal teardown must treat as success). */
function notFound(what) {
  return Object.assign(new Error(`${what}: not found`), { statusCode: 404 });
}

/**
 * A minimal in-memory dockerode double. `opts` injects failures at each step so
 * rollback and teardown-surfacing paths are reachable.
 */
function makeFakeDocker(opts = {}) {
  let seq = 0;
  const networks = new Set();
  const volumes = new Set();
  const containers = new Set();
  const events = { pulled: [], started: [], stopped: [], removedContainers: [] };

  function networkHandle(id) {
    return {
      id,
      async remove() {
        if (opts.networkRemoveFail && networks.has(id)) throw opts.networkRemoveFail;
        networks.delete(id);
      },
      async inspect() {
        if (!networks.has(id)) throw notFound('network');
        return { Id: id };
      },
    };
  }
  function volumeHandle(name) {
    return {
      async remove() {
        if (opts.volumeRemoveFail && volumes.has(name)) throw opts.volumeRemoveFail;
        volumes.delete(name);
      },
      async inspect() {
        if (!volumes.has(name)) throw notFound('volume');
        return { Name: name };
      },
    };
  }
  function containerHandle(id) {
    return {
      id,
      async start() {
        if (opts.startFail) throw opts.startFail;
        events.started.push(id);
      },
      async stop() {
        events.stopped.push(id);
      },
      async remove() {
        if (opts.containerRemoveFail && containers.has(id)) throw opts.containerRemoveFail;
        events.removedContainers.push(id);
        containers.delete(id);
      },
      async inspect() {
        if (!containers.has(id)) throw notFound('container');
        return { Id: id };
      },
      async logs(o) {
        const frame = (text, stream = 1) => {
          const payload = Buffer.from(text);
          const header = Buffer.alloc(8);
          header[0] = stream;
          header.writeUInt32BE(payload.length, 4);
          return Buffer.concat([header, payload]);
        };
        // Non-follow is framed exactly like follow — same non-TTY container.
        if (!o.follow) return Buffer.concat([frame('his'), frame('tory', 2)]);
        // A non-TTY container's follow stream is FRAMED: an 8-byte header per
        // chunk (stream byte, 3 pad, 4-byte big-endian length) before the
        // payload. The fake must emit real frames or it cannot catch a demux
        // bug — a stub that hands back clean text tests nothing.
        return Readable.from([frame('live-stream')]);
      },
    };
  }

  return {
    state: { networks, volumes, containers, events },
    modem: {
      followProgress(_stream, done) {
        done(null, []);
      },
      // Real dockerode demuxes docker's 8-byte stream frames. A fake that omits
      // it lets a demux bug ship, so model it: strip the header from each frame.
      demuxStream(source, stdout, _stderr) {
        source.on('data', (chunk) => stdout.write(chunk.subarray(8)));
      },
    },
    pull(ref, cb) {
      if (opts.pullFail) return cb(opts.pullFail);
      events.pulled.push(ref);
      cb(null, {});
    },
    async createNetwork(o) {
      if (opts.networkCreateFail) throw opts.networkCreateFail;
      const id = `net-${++seq}`;
      networks.add(id);
      return networkHandle(id);
    },
    async createVolume(o) {
      if (opts.volumeCreateFail) throw opts.volumeCreateFail;
      volumes.add(o.Name);
      return { Name: o.Name };
    },
    async createContainer(_o) {
      if (opts.containerCreateFail) throw opts.containerCreateFail;
      const id = `ctr-${++seq}`;
      containers.add(id);
      return containerHandle(id);
    },
    getContainer: (id) => containerHandle(id),
    getNetwork: (id) => networkHandle(id),
    getVolume: (name) => volumeHandle(name),
    getImage: (ref) => ({
      async inspect() {
        // Real docker reports `repository@sha256:…` — never with a tag.
        const repo = (ref.split('@')[0] ?? ref).replace(/:[^:/]+$/, '');
        return { RepoDigests: [`${repo}@${DIGEST}`], Id: 'sha256:imgid' };
      },
    }),
  };
}

describe('createDockerEngine — createJobContainer applies the clamp and provisions cleanly', () => {
  it('pulls by digest, creates the per-job network+volume+container, starts it, returns the handle', async () => {
    const docker = makeFakeDocker();
    const engine = createDockerEngine({ docker, env: {} });

    const handle = await engine.createJobContainer({
      jobId: JOB_ID,
      policy: enginePolicy(),
      leaseExpiresAt: '2026-07-10T12:00:00.000Z',
    });

    assert.equal(handle.volumeName, `omadia-job-${JOB_ID}`);
    assert.equal(handle.imageDigest, DIGEST);
    assert.ok(handle.containerId.startsWith('ctr-'));
    assert.ok(handle.networkId.startsWith('net-'));
    assert.deepEqual(docker.state.events.pulled, [DIGEST_IMAGE], 'pulled the digest ref');
    assert.equal(docker.state.networks.size, 1, 'one per-job network');
    assert.equal(docker.state.volumes.size, 1, 'one per-job volume');
    assert.equal(docker.state.containers.size, 1, 'one container');
    assert.equal(docker.state.events.started.length, 1, 'the container was started');
  });

  it('refuses a floating-tag image with spec_rejected BEFORE creating any resource', async () => {
    const docker = makeFakeDocker();
    const engine = createDockerEngine({ docker, env: {} });

    await assert.rejects(
      () =>
        engine.createJobContainer({
          jobId: JOB_ID,
          policy: enginePolicy('ghcr.io/byte5ai/omadia-dev-runner:latest'),
          leaseExpiresAt: '2026-07-10T12:00:00.000Z',
        }),
      (err) => err instanceof SpecRejectedError && err.reason === 'image_not_digest_pinned',
    );
    assert.equal(docker.state.events.pulled.length, 0, 'no pull for a rejected spec');
    assert.equal(docker.state.networks.size, 0, 'no network for a rejected spec');
    assert.equal(docker.state.volumes.size, 0, 'no volume for a rejected spec');
  });

  it('rolls back the network and volume when the container fails to start', async () => {
    const docker = makeFakeDocker({ startFail: new Error('OCI start failed') });
    const engine = createDockerEngine({ docker, env: {} });

    await assert.rejects(
      () =>
        engine.createJobContainer({
          jobId: JOB_ID,
          policy: enginePolicy(),
          leaseExpiresAt: '2026-07-10T12:00:00.000Z',
        }),
      /OCI start failed/,
    );
    assert.equal(docker.state.containers.size, 0, 'the created container was removed');
    assert.equal(docker.state.networks.size, 0, 'the per-job network was removed');
    assert.equal(docker.state.volumes.size, 0, 'the per-job volume was removed');
  });

  it('rolls back the network and volume when createContainer itself fails', async () => {
    const docker = makeFakeDocker({ containerCreateFail: new Error('no such image') });
    const engine = createDockerEngine({ docker, env: {} });

    await assert.rejects(
      () =>
        engine.createJobContainer({
          jobId: JOB_ID,
          policy: enginePolicy(),
          leaseExpiresAt: '2026-07-10T12:00:00.000Z',
        }),
      /no such image/,
    );
    assert.equal(docker.state.networks.size, 0, 'network rolled back');
    assert.equal(docker.state.volumes.size, 0, 'volume rolled back');
  });

  it('honours env-tuned limits in the create-options handed to dockerode', async () => {
    let captured;
    const base = makeFakeDocker();
    const docker = {
      ...base,
      async createContainer(o) {
        captured = o;
        return base.createContainer(o);
      },
    };
    const engine = createDockerEngine({ docker, env: { DEV_JOB_MEM: '8g', DEV_JOB_PIDS: '1024' } });
    await engine.createJobContainer({
      jobId: JOB_ID,
      policy: enginePolicy(),
      leaseExpiresAt: '2026-07-10T12:00:00.000Z',
    });
    assert.equal(captured.HostConfig.Memory, 8 * 1024 ** 3);
    assert.equal(captured.HostConfig.PidsLimit, 1024);
    assert.equal(captured.User, '1000:1000');
    assert.equal(captured.HostConfig.ReadonlyRootfs, true);
  });
});

describe('createDockerEngine — destroyJobContainer removes all three, verifies, and is idempotent', () => {
  const handle = {
    containerId: 'ctr-1',
    networkId: 'net-1',
    volumeName: `omadia-job-${JOB_ID}`,
    imageDigest: DIGEST,
  };

  it('removes container, network and volume, then a second call still succeeds', async () => {
    const docker = makeFakeDocker();
    docker.state.containers.add('ctr-1');
    docker.state.networks.add('net-1');
    docker.state.volumes.add(handle.volumeName);
    const engine = createDockerEngine({ docker, env: {} });

    await engine.destroyJobContainer(handle);
    assert.equal(docker.state.containers.size, 0, 'container gone');
    assert.equal(docker.state.networks.size, 0, 'network gone');
    assert.equal(docker.state.volumes.size, 0, 'volume gone');
    assert.deepEqual(docker.state.events.stopped, ['ctr-1'], 'graceful stop was attempted');

    // Idempotent: a second teardown on the now-empty state finds 404s and succeeds.
    await engine.destroyJobContainer(handle);
  });

  it('idempotent on a partially-removed job: only the volume remains, teardown clears it', async () => {
    const docker = makeFakeDocker();
    docker.state.volumes.add(handle.volumeName); // container + network already gone
    const engine = createDockerEngine({ docker, env: {} });

    await engine.destroyJobContainer(handle);
    assert.equal(docker.state.volumes.size, 0, 'the surviving volume was removed');
  });

  it('surfaces a teardown failure (so the caller keeps the handle to retry)', async () => {
    const docker = makeFakeDocker({ volumeRemoveFail: new Error('volume in use') });
    docker.state.containers.add('ctr-1');
    docker.state.networks.add('net-1');
    docker.state.volumes.add(handle.volumeName);
    const engine = createDockerEngine({ docker, env: {} });

    await assert.rejects(() => engine.destroyJobContainer(handle), /volume in use|failed to fully remove/);
    // Container and network were still cleaned; only the volume remains for retry.
    assert.equal(docker.state.containers.size, 0);
    assert.equal(docker.state.networks.size, 0);
    assert.equal(docker.state.volumes.size, 1, 'the unremovable volume is kept, not silently forgotten');
  });
});

describe('createDockerEngine — streamLogs and warmImages', () => {
  it('returns a Readable of combined output, honouring follow', async () => {
    const docker = makeFakeDocker();
    const engine = createDockerEngine({ docker, env: {} });
    const followed = await engine.streamLogs({ containerId: 'ctr-1' }, { follow: true });
    assert.ok(followed instanceof Readable);
    const live = [];
    for await (const c of followed) live.push(c);
    assert.equal(
      Buffer.concat(live).toString(),
      'live-stream',
      "follow yields demuxed text — docker's 8-byte frame headers never reach the operator",
    );
    const once = await engine.streamLogs({ containerId: 'ctr-1' }, { follow: false });
    assert.ok(once instanceof Readable);
    const chunks = [];
    for await (const c of once) chunks.push(c);
    assert.equal(
      Buffer.concat(chunks).toString(),
      'history',
      "non-follow is demuxed too — stdout and stderr frames combined, no wire headers",
    );
  });

  it('warmImages pulls each ref and returns the resolved digests', async () => {
    const docker = makeFakeDocker();
    const engine = createDockerEngine({ docker, env: {} });
    const digests = await engine.warmImages(['ghcr.io/byte5ai/omadia-dev-runner:v1', 'registry.npmjs.org/x:2']);
    assert.deepEqual(digests, [DIGEST, DIGEST]);
    assert.equal(docker.state.events.pulled.length, 2, 'both refs were pulled');
  });
});

// Real dockerode against the local engine. Skipped in the default suite; run with
// DEV_RUNNER_DOCKER_IT=1 to exercise a genuine hardened container end-to-end.
const RUN_DOCKER_IT = process.env.DEV_RUNNER_DOCKER_IT === '1';
describe('createDockerEngine — real dockerode integration', { skip: !RUN_DOCKER_IT }, () => {
  it('creates a hardened container docker-inspect confirms, then reaps it idempotently', async () => {
    // Honour DOCKER_HOST for a unix socket (dockerode's default does not read it),
    // so a non-standard engine socket (OrbStack, rootless) is reachable.
    const dockerHost = process.env.DOCKER_HOST;
    const docker =
      dockerHost && dockerHost.startsWith('unix://')
        ? new Docker({ socketPath: dockerHost.slice('unix://'.length) })
        : new Docker();
    const ref = 'alpine:3.20';
    // Ensure the image is present and resolve its digest ref.
    await new Promise((resolve, reject) =>
      docker.pull(ref, (err, stream) =>
        err || !stream ? reject(err ?? new Error('no stream')) : docker.modem.followProgress(stream, (e) => (e ? reject(e) : resolve(undefined))),
      ),
    );
    const info = await docker.getImage(ref).inspect();
    const digestRef = info.RepoDigests?.[0];
    assert.ok(digestRef && digestRef.includes('@sha256:'), `alpine has a digest ref: ${digestRef}`);

    const engine = createDockerEngine({ docker, env: {} });
    const itJobId = `it-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const policy = { jobId: itJobId, image: digestRef, env: { OMADIA_JOB_ID: itJobId }, egressAllowlist: [] };

    const handle = await engine.createJobContainer({
      jobId: itJobId,
      policy,
      leaseExpiresAt: new Date(Date.now() + 180_000).toISOString(),
    });
    try {
      const insp = await docker.getContainer(handle.containerId).inspect();
      assert.equal(insp.Config.User, '1000:1000', 'non-root');
      assert.equal(insp.HostConfig.ReadonlyRootfs, true, 'read-only rootfs');
      assert.deepEqual(insp.HostConfig.CapDrop, ['ALL'], 'all caps dropped');
      assert.ok(insp.HostConfig.CapAdd == null || insp.HostConfig.CapAdd.length === 0, 'no CapAdd');
      assert.ok(insp.HostConfig.SecurityOpt.some((s) => s.includes('no-new-privileges')), 'no-new-privileges');
      assert.equal(insp.HostConfig.Privileged, false, 'not privileged');
      assert.equal(insp.HostConfig.Memory, 4 * 1024 ** 3, 'memory capped');
      assert.equal(insp.HostConfig.PidsLimit, 512, 'pids capped');
      assert.equal(insp.HostConfig.NetworkMode, `omadia-job-${itJobId}`, 'per-job network, not host/bridge');
      assert.ok(
        insp.HostConfig.Binds?.includes(`omadia-job-${itJobId}:/workspace`),
        'only the per-job workspace volume is bound',
      );
      // The per-job network and volume really exist.
      await docker.getNetwork(handle.networkId).inspect();
      await docker.getVolume(handle.volumeName).inspect();
    } finally {
      await engine.destroyJobContainer(handle);
    }

    // Everything is gone, and a second teardown is idempotent.
    await assert.rejects(() => docker.getContainer(handle.containerId).inspect(), /no such container|not found|404/i);
    await assert.rejects(() => docker.getNetwork(handle.networkId).inspect(), /not found|404/i);
    await assert.rejects(() => docker.getVolume(handle.volumeName).inspect(), /no such volume|not found|404/i);
    await engine.destroyJobContainer(handle);
  });
});

describe('createDockerEngine — a rollback that fails must not be silent', () => {
  it('names the resources that survived a failed create + failed cleanup', async () => {
    const docker = makeFakeDocker({
      startFail: new Error('start refused'),
      containerRemoveFail: new Error('docker is down'),
    });
    const engine = createDockerEngine({ docker, env: {} });
    await assert.rejects(
      () =>
        engine.createJobContainer({
          jobId: JOB_ID,
          policy: { image: `alpine@sha256:${'a'.repeat(64)}`, env: {}, egressAllowlist: [] },
          leaseExpiresAt: new Date(0).toISOString(),
        }),
      (err) => {
        assert.equal(err.code, 'daemon.create_rollback_failed');
        // Nothing holds a handle on these — the error is the only trace.
        assert.ok(err.resources.some((r) => r.includes(JOB_ID.slice(0, 8))), 'the surviving resources are named');
        return true;
      },
    );
  });
});

describe('dev-runner image — the job workspace is writable by uid 1000', { skip: !RUN_DOCKER_IT }, () => {
  it('a fresh named volume mounted at /workspace comes up owned by the runner user', async () => {
    // The clamp runs the container as 1000:1000 with a read-only rootfs and
    // mounts a FRESH named volume at /workspace. Docker copies an image
    // directory's contents AND ownership into an empty volume on first mount —
    // but only when that directory is non-empty. Without the image's `.keep`
    // the volume is root-owned and every job dies with EACCES on its first
    // write. This asserts the property against the REAL image.
    const dockerHost = process.env.DOCKER_HOST;
    const docker =
      dockerHost && dockerHost.startsWith('unix://')
        ? new Docker({ socketPath: dockerHost.slice('unix://'.length) })
        : new Docker();
    const image = process.env.DEV_RUNNER_IT_IMAGE ?? 'omadia-dev-runner:wsfix';
    const volumeName = `omadia-it-ws-${Date.now()}`;
    await docker.createVolume({ Name: volumeName });
    try {
      const container = await docker.createContainer({
        Image: image,
        User: '1000:1000',
        Entrypoint: ['sh', '-c'],
        Cmd: ['touch /workspace/probe && stat -c "%u" /workspace'],
        HostConfig: { ReadonlyRootfs: true, CapDrop: ['ALL'], Binds: [`${volumeName}:/workspace`], AutoRemove: false },
      });
      try {
        await container.start();
        const { StatusCode } = await container.wait();
        const logs = (await container.logs({ stdout: true, stderr: true, follow: false })).toString();
        assert.equal(StatusCode, 0, `the runner could not write to /workspace: ${logs}`);
        assert.ok(logs.includes('1000'), `/workspace is not owned by uid 1000: ${logs}`);
      } finally {
        await container.remove({ force: true }).catch(() => {});
      }
    } finally {
      await docker.getVolume(volumeName).remove({ force: true }).catch(() => {});
    }
  });
});

/**
 * Epic #470 W1 — the egress proxy is default-deny and knows nothing about a job
 * until the daemon registers it. Registration is therefore not an optimisation:
 * an unregistered job is answered 407 on EVERY request, which inside the runner
 * is indistinguishable from a total network outage.
 */
describe('JobManager — egress-proxy registration is part of provisioning', () => {
  function recordingProxyClient(overrides = {}) {
    const calls = [];
    return {
      calls,
      async register(jobId, entry) {
        calls.push({ op: 'register', jobId, entry });
        if (overrides.registerError) throw overrides.registerError;
      },
      async unregister(jobId) {
        calls.push({ op: 'unregister', jobId });
        if (overrides.unregisterError) throw overrides.unregisterError;
        return true;
      },
    };
  }

  /** An engine that records the order of operations against the proxy calls. */
  function orderedEngine(order, opts = {}) {
    return {
      async createJobContainer() {
        order.push('createContainer');
        if (opts.createError) throw opts.createError;
        return { jobId: JOB_ID, id: 'c1', networkId: 'n1', volumeName: 'v1', imageDigest: 'sha256:abc' };
      },
      async destroyJobContainer() {
        order.push('destroyContainer');
        if (opts.destroyError) throw opts.destroyError;
      },
    };
  }

  it('registers the job with the proxy BEFORE the container starts', async () => {
    const order = [];
    const proxy = recordingProxyClient();
    const wrapped = {
      ...proxy,
      async register(jobId, entry) {
        order.push('register');
        return proxy.register(jobId, entry);
      },
    };
    const jm = new JobManager({ engine: orderedEngine(order), policyClient: fakePolicyClient(), proxyClient: wrapped });
    await jm.create(JOB_ID, 180);
    assert.deepEqual(order, ['register', 'createContainer'], 'a container must never boot before its egress authorisation exists');
  });

  it('passes the policy allowlist and a fresh token, with a TTL covering the hard deadline', async () => {
    const proxy = recordingProxyClient();
    const policyClient = {
      async fetchJobPolicy(jobId, opts) {
        // The daemon mints the token and threads it into the container's proxy URL.
        assert.equal(typeof opts?.proxyToken, 'string');
        assert.match(opts.proxyToken, /^[0-9a-f]{64}$/, 'hex, so the URL userinfo round-trip is unambiguous');
        return { jobId, image: 'ghcr.io/x/y@sha256:abc', env: {}, egressAllowlist: ['registry.npmjs.org'] };
      },
    };
    const jm = new JobManager({
      engine: orderedEngine([]),
      policyClient,
      proxyClient: proxy,
      maxJobLifetimeMs: 3_600_000,
    });
    await jm.create(JOB_ID, 180);
    const reg = proxy.calls.find((c) => c.op === 'register');
    assert.deepEqual(reg.entry.allowlist, ['registry.npmjs.org']);
    assert.equal(reg.entry.ttlSec, 3600, 'the TTL is the hard deadline, not the 180s lease');
    assert.match(reg.entry.proxyToken, /^[0-9a-f]{64}$/);
  });

  it('aborts the create when the proxy refuses the registration', async () => {
    // Fail closed: a job that boots without egress authorisation looks like a
    // broken network to the agent inside it, and burns a whole run.
    const order = [];
    const proxy = recordingProxyClient({ registerError: new Error('proxy.control_unreachable') });
    const jm = new JobManager({ engine: orderedEngine(order), policyClient: fakePolicyClient(), proxyClient: proxy });
    await assert.rejects(() => jm.create(JOB_ID, 180), /proxy.control_unreachable/);
    assert.deepEqual(order, [], 'no container was created');
    assert.equal(jm.size(), 0);
  });

  it('withdraws the registration when the container fails to start', async () => {
    const proxy = recordingProxyClient();
    const jm = new JobManager({
      engine: orderedEngine([], { createError: new Error('boom') }),
      policyClient: fakePolicyClient(),
      proxyClient: proxy,
    });
    await assert.rejects(() => jm.create(JOB_ID, 180), /boom/);
    assert.deepEqual(proxy.calls.map((c) => c.op), ['register', 'unregister']);
  });

  it('withdraws the registration only AFTER the container is proven gone', async () => {
    const order = [];
    const proxy = recordingProxyClient();
    const wrapped = {
      ...proxy,
      async unregister(jobId) {
        order.push('unregister');
        return proxy.unregister(jobId);
      },
    };
    const jm = new JobManager({ engine: orderedEngine(order), policyClient: fakePolicyClient(), proxyClient: wrapped });
    await jm.create(JOB_ID, 180);
    await jm.destroy(JOB_ID);
    assert.deepEqual(
      order,
      ['createContainer', 'destroyContainer', 'unregister'],
      'stripping egress from a container whose teardown then failed would leave it running and blind',
    );
  });

  it('keeps the egress authorisation when the teardown itself fails', async () => {
    const proxy = recordingProxyClient();
    const jm = new JobManager({
      engine: orderedEngine([], { destroyError: new Error('cleanup failed') }),
      policyClient: fakePolicyClient(),
      proxyClient: proxy,
    });
    await jm.create(JOB_ID, 180);
    await assert.rejects(() => jm.destroy(JOB_ID));
    assert.deepEqual(proxy.calls.map((c) => c.op), ['register'], 'the container may still be running');
  });

  it('a failed withdrawal is logged, never thrown — the registration expires on its own', async () => {
    const logs = [];
    const proxy = recordingProxyClient({ unregisterError: new Error('proxy down') });
    const jm = new JobManager({
      engine: orderedEngine([]),
      policyClient: fakePolicyClient(),
      proxyClient: proxy,
      log: (m) => logs.push(m),
    });
    await jm.create(JOB_ID, 180);
    assert.equal(await jm.destroy(JOB_ID), true, 'the container IS gone; the job is destroyed');
    assert.ok(logs.some((l) => l.includes('could not withdraw egress authorisation')));
  });

  it('does nothing proxy-shaped when no proxy is configured', async () => {
    const jm = new JobManager({ engine: orderedEngine([]), policyClient: fakePolicyClient() });
    await jm.create(JOB_ID, 180);
    await jm.destroy(JOB_ID);
    assert.equal(jm.size(), 0);
  });
});
