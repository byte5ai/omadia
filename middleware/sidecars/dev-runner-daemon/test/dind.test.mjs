/**
 * Epic #470 W5 — opt-in per-job rootless Docker-in-Docker sidecar (spec §8).
 *
 * Driven against a NAME-ADDRESSABLE fake dockerode (the sidecar is torn down by its
 * deterministic name, unlike the unnamed job container), so the orchestration is
 * asserted without a running engine:
 *
 *   - dockerInJob set   → a dind-rootless sidecar is created + started on the JOB's
 *                         isolated network BEFORE the job container; the job gets
 *                         DOCKER_HOST + TLS certs; the sidecar has a size-capped
 *                         image-store volume, the job's cpu/mem/pids limits, NO host
 *                         mounts, and never a privileged flag; teardown destroys the
 *                         sidecar + BOTH its volumes WITH the job.
 *   - dockerInJob unset → NO sidecar, byte-identical to before W5.
 *
 * The real docker:dind-rootless internals (data-root path, seccomp/apparmor, TLS
 * certdir) are ASSUMED — they cannot run here — and pinned as structural asserts so
 * a reviewer sees exactly what shape the daemon hands dockerode.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  dindCertsVolumeName,
  dindContainerName,
  dindVolumeName,
  jobNetworkName,
  jobVolumeName,
} from '../src/clamp.mjs';
import { createDockerEngine } from '../src/jobs.mjs';

const JOB_ID = '22222222-2222-4222-8222-222222222222';
const DIGEST = `sha256:${'3'.repeat(64)}`;
const IMAGE = `ghcr.io/byte5ai/omadia-dev-runner@${DIGEST}`;
const LEASE = '2026-07-11T12:00:00.000Z';

/** @returns {import('../src/policyClient.mjs').DerivedJobPolicy} */
function policy(extra = {}) {
  return { jobId: JOB_ID, image: IMAGE, env: { OMADIA_JOB_ID: JOB_ID }, egressAllowlist: [], ...extra };
}

function notFound(what) {
  return Object.assign(new Error(`${what}: not found`), { statusCode: 404 });
}

/**
 * A name-addressable in-memory dockerode double. Containers resolve by BOTH the
 * generated id and the create-time `name` (docker's real behaviour), which is what
 * lets teardown-by-deterministic-name work. `opts.jobCreateFail` fails the UNNAMED
 * (job) container's create so the sidecar-rollback path is reachable.
 */
function makeFakeDocker(opts = {}) {
  let seq = 0;
  const byId = new Map();
  const byName = new Map();
  const networks = new Map();
  const volumes = new Map();
  const events = { pulled: [], started: [], createOrder: [] };

  function handleFor(rec) {
    return {
      id: rec.id,
      async start() {
        if (opts.startFail && !rec.options.name) throw opts.startFail;
        events.started.push(rec.options.name ?? 'job');
        rec.running = true;
      },
      async stop() {},
      async remove() {
        byId.delete(rec.id);
        if (rec.options.name) byName.delete(rec.options.name);
      },
      async inspect() {
        if (!byId.has(rec.id)) throw notFound('container');
        return { Id: rec.id };
      },
    };
  }
  function missing(ref) {
    return {
      id: ref,
      async start() {},
      async stop() {},
      async remove() {
        throw notFound('container');
      },
      async inspect() {
        throw notFound('container');
      },
    };
  }
  function networkHandle(id) {
    return {
      id,
      async remove() {
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
        volumes.delete(name);
      },
      async inspect() {
        if (!volumes.has(name)) throw notFound('volume');
        return { Name: name };
      },
    };
  }

  return {
    state: { byId, byName, networks, volumes, events },
    modem: {
      followProgress(_s, done) {
        done(null, []);
      },
      demuxStream() {},
    },
    pull(ref, cb) {
      events.pulled.push(ref);
      cb(null, {});
    },
    async createNetwork(o) {
      const id = `net-${++seq}`;
      networks.set(id, o);
      return networkHandle(id);
    },
    async createVolume(o) {
      volumes.set(o.Name, o);
      return { Name: o.Name };
    },
    async createContainer(o) {
      if (opts.jobCreateFail && !o.name) throw opts.jobCreateFail;
      const id = `ctr-${++seq}`;
      const rec = { id, options: o, running: false };
      byId.set(id, rec);
      if (o.name) byName.set(o.name, rec);
      events.createOrder.push(o.name ?? 'job');
      return handleFor(rec);
    },
    getContainer(ref) {
      const rec = byId.get(ref) ?? byName.get(ref);
      return rec ? handleFor(rec) : missing(ref);
    },
    getNetwork: (id) => networkHandle(id),
    getVolume: (name) => volumeHandle(name),
    getImage: (ref) => ({
      async inspect() {
        const repo = (ref.split('@')[0] ?? ref).replace(/:[^:/]+$/, '');
        return { RepoDigests: [`${repo}@${DIGEST}`], Id: 'sha256:imgid' };
      },
    }),
  };
}

/** The job container's captured create-options (the one WITHOUT a name). */
function jobRecord(docker) {
  return [...docker.state.byId.values()].find((r) => !r.options.name);
}

describe('createDockerEngine — DinD sidecar provisioning (spec §8)', () => {
  it('starts a dind sidecar on the job network BEFORE the job container, size-capped, no host mounts', async () => {
    const docker = makeFakeDocker();
    const engine = createDockerEngine({ docker, env: {} });

    const handle = await engine.createJobContainer({ jobId: JOB_ID, policy: policy({ dockerInJob: true }), leaseExpiresAt: LEASE });

    // Ordering: the sidecar is created AND started before the job container.
    assert.deepEqual(docker.state.events.createOrder, [dindContainerName(JOB_ID), 'job'], 'sidecar created before job');
    assert.deepEqual(docker.state.events.started, [dindContainerName(JOB_ID), 'job'], 'sidecar started before job');

    const sidecar = docker.state.byName.get(dindContainerName(JOB_ID));
    assert.ok(sidecar, 'the sidecar container exists');
    const hc = sidecar.options.HostConfig;
    assert.equal(hc.NetworkMode, jobNetworkName(JOB_ID), 'sidecar sits on the job isolated network');
    assert.deepEqual(
      sidecar.options.NetworkingConfig.EndpointsConfig[jobNetworkName(JOB_ID)].Aliases,
      ['dind'],
      'reachable at the dind alias so DOCKER_HOST resolves',
    );
    // No host mounts: every bind is a NAMED per-job volume, never a host path.
    assert.equal(hc.Binds.length, 2);
    for (const bind of hc.Binds) assert.ok(!bind.startsWith('/'), `no host mount: ${bind}`);
    assert.ok(hc.Binds.some((b) => b.startsWith(`${dindVolumeName(JOB_ID)}:`)), 'nested image-store volume mounted');
    assert.ok(hc.Binds.some((b) => b.startsWith(`${dindCertsVolumeName(JOB_ID)}:`)), 'certs volume mounted');
    // Same clamp as the job; never privileged; relaxed seccomp/apparmor (documented cost).
    assert.equal(hc.Memory, 4 * 1024 ** 3);
    assert.equal(hc.PidsLimit, 512);
    assert.equal(hc.Privileged, false);
    assert.deepEqual(hc.SecurityOpt, ['seccomp=unconfined', 'apparmor=unconfined']);
    assert.deepEqual(hc.RestartPolicy, { Name: 'no' });

    // The size-capped nested-image-store volume + the certs volume both exist.
    const store = docker.state.volumes.get(dindVolumeName(JOB_ID));
    assert.equal(store.DriverOpts.size, '10g', 'DEV_DIND_DISK_GB default 10 GiB is threaded to the store cap');
    assert.ok(docker.state.volumes.has(dindCertsVolumeName(JOB_ID)), 'certs volume created');
    assert.ok(docker.state.volumes.has(jobVolumeName(JOB_ID)), 'workspace volume still created');

    // The JOB container is wired at the sidecar over TLS with the per-job certs.
    const job = jobRecord(docker);
    assert.ok(job.options.Env.includes('DOCKER_HOST=tcp://dind:2376'));
    assert.ok(job.options.Env.includes('DOCKER_TLS_VERIFY=1'));
    assert.ok(job.options.Env.includes('DOCKER_CERT_PATH=/certs/client'));
    assert.ok(
      job.options.HostConfig.Binds.includes(`${dindCertsVolumeName(JOB_ID)}:/certs:ro`),
      'job mounts the certs volume READ-ONLY',
    );
    assert.equal(job.options.Labels['ai.omadia.dev.role'], 'job');
    assert.equal(job.options.Labels['ai.omadia.dev.dockerInJob'], 'true');

    assert.equal(handle.dockerInJob, true);
    assert.equal(handle.jobId, JOB_ID);
  });

  it('honours DEV_DIND_DISK_GB and DEV_DIND_IMAGE overrides', async () => {
    const docker = makeFakeDocker();
    const engine = createDockerEngine({ docker, env: { DEV_DIND_DISK_GB: '25', DEV_DIND_IMAGE: 'mirror.local/docker:dind-rootless' } });

    await engine.createJobContainer({ jobId: JOB_ID, policy: policy({ dockerInJob: true }), leaseExpiresAt: LEASE });

    assert.equal(docker.state.volumes.get(dindVolumeName(JOB_ID)).DriverOpts.size, '25g');
    assert.equal(docker.state.byName.get(dindContainerName(JOB_ID)).options.Image, 'mirror.local/docker:dind-rootless');
    assert.ok(docker.state.events.pulled.includes('mirror.local/docker:dind-rootless'), 'the sidecar image is pulled');
  });

  it('tears the sidecar + BOTH its volumes down WITH the job', async () => {
    const docker = makeFakeDocker();
    const engine = createDockerEngine({ docker, env: {} });
    const handle = await engine.createJobContainer({ jobId: JOB_ID, policy: policy({ dockerInJob: true }), leaseExpiresAt: LEASE });

    await engine.destroyJobContainer(handle);

    assert.equal(docker.state.byName.has(dindContainerName(JOB_ID)), false, 'sidecar container gone');
    assert.equal(docker.state.byId.size, 0, 'both containers gone');
    assert.equal(docker.state.networks.size, 0, 'network gone');
    assert.equal(docker.state.volumes.has(dindVolumeName(JOB_ID)), false, 'image-store volume gone');
    assert.equal(docker.state.volumes.has(dindCertsVolumeName(JOB_ID)), false, 'certs volume gone');
    assert.equal(docker.state.volumes.has(jobVolumeName(JOB_ID)), false, 'workspace volume gone');
  });

  it('tears the sidecar down on a reaper-reconstructed handle (dockerInJob from the label)', async () => {
    // The reaper rebuilds a teardown handle from labels alone (containerId + the
    // deterministic names) and sets dockerInJob from the job container's label.
    const docker = makeFakeDocker();
    const engine = createDockerEngine({ docker, env: {} });
    await engine.createJobContainer({ jobId: JOB_ID, policy: policy({ dockerInJob: true }), leaseExpiresAt: LEASE });
    const jobId = JOB_ID;
    const jobCtr = jobRecord(docker);

    // Exactly the shape reaper.rebuild()/reapOrphans() construct.
    await engine.destroyJobContainer({
      jobId,
      containerId: jobCtr.id,
      networkId: jobNetworkName(jobId),
      volumeName: jobVolumeName(jobId),
      imageDigest: '',
      dockerInJob: true,
    });

    assert.equal(docker.state.byName.has(dindContainerName(jobId)), false, 'sidecar swept on the reconstructed path');
    assert.equal(docker.state.volumes.has(dindVolumeName(jobId)), false);
    assert.equal(docker.state.volumes.has(dindCertsVolumeName(jobId)), false);
  });

  it('rolls back the sidecar + its volumes when the job container fails', async () => {
    const docker = makeFakeDocker({ jobCreateFail: new Error('no such job image') });
    const engine = createDockerEngine({ docker, env: {} });

    await assert.rejects(
      () => engine.createJobContainer({ jobId: JOB_ID, policy: policy({ dockerInJob: true }), leaseExpiresAt: LEASE }),
      /no such job image/,
    );

    assert.equal(docker.state.byId.size, 0, 'the sidecar container was rolled back');
    assert.equal(docker.state.byName.size, 0);
    assert.equal(docker.state.networks.size, 0, 'network rolled back');
    assert.equal(docker.state.volumes.size, 0, 'all three volumes rolled back');
  });
});

describe('createDockerEngine — no DinD when the repo did not opt in (byte-identical to before W5)', () => {
  it('creates no sidecar, no extra volumes, and a teardown that never touches one', async () => {
    const docker = makeFakeDocker();
    const engine = createDockerEngine({ docker, env: {} });

    const handle = await engine.createJobContainer({ jobId: JOB_ID, policy: policy(), leaseExpiresAt: LEASE });

    assert.deepEqual(docker.state.events.createOrder, ['job'], 'exactly one container, the job');
    assert.equal(docker.state.byName.size, 0, 'no named sidecar container');
    assert.equal(docker.state.volumes.size, 1, 'only the workspace volume');
    assert.ok(docker.state.volumes.has(jobVolumeName(JOB_ID)));
    assert.notEqual(handle.dockerInJob, true);

    // The job container carries the role label but NOT the dockerInJob marker, and
    // no DOCKER_* env / certs bind.
    const job = jobRecord(docker);
    assert.equal(job.options.Labels['ai.omadia.dev.role'], 'job');
    assert.equal(job.options.Labels['ai.omadia.dev.dockerInJob'], undefined);
    assert.deepEqual(job.options.HostConfig.Binds, [`${jobVolumeName(JOB_ID)}:/workspace`]);
    assert.ok(!job.options.Env.some((e) => e.startsWith('DOCKER_HOST=')), 'no DOCKER_HOST injected');

    await engine.destroyJobContainer(handle);
    assert.equal(docker.state.byId.size, 0);
    assert.equal(docker.state.volumes.size, 0);
    assert.equal(docker.state.networks.size, 0);
  });
});

describe('createDockerEngine — listManagedResources excludes the sidecar container', () => {
  function makeListDocker(inventory) {
    return {
      async listContainers() {
        return inventory.containers;
      },
      async listNetworks() {
        return inventory.networks;
      },
      async listVolumes() {
        return { Volumes: inventory.volumes };
      },
    };
  }

  it('reports the job container (with dockerInJob) but NOT the dind sidecar; surfaces sidecar volumes', async () => {
    const createdBy = 'omadia-middleware';
    const label = (role, extra = {}) => ({
      'ai.omadia.dev.jobId': JOB_ID,
      'ai.omadia.dev.createdBy': createdBy,
      'ai.omadia.dev.role': role,
      ...extra,
    });
    const docker = makeListDocker({
      containers: [
        { Id: 'ctr-job', State: 'running', Image: IMAGE, Created: 1, Labels: label('job', { 'ai.omadia.dev.dockerInJob': 'true' }) },
        { Id: 'ctr-dind', State: 'running', Image: 'docker:dind-rootless', Created: 1, Labels: label('dind') },
      ],
      networks: [{ Id: 'net-1', Name: jobNetworkName(JOB_ID), Labels: label('job') }],
      volumes: [
        { Name: jobVolumeName(JOB_ID), Labels: label('job') },
        { Name: dindVolumeName(JOB_ID), Labels: label('dind') },
        { Name: dindCertsVolumeName(JOB_ID), Labels: label('dind') },
      ],
    });
    const engine = createDockerEngine({ docker, env: {} });

    const inv = await engine.listManagedResources();
    assert.equal(inv.containers.length, 1, 'the dind sidecar is NOT adopted as a job container');
    assert.equal(inv.containers[0].containerId, 'ctr-job');
    assert.equal(inv.containers[0].dockerInJob, true, 'the dockerInJob label is surfaced for teardown');
    // The sidecar volumes DO surface, so a stranded sidecar volume still triggers the sweep.
    assert.equal(inv.volumes.length, 3);
  });
});
