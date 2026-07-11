/**
 * Epic #470 W1 — the hardening clamp table (spec §4). THE CLAMP IS THE ISOLATION,
 * so this asserts directly on the object `buildContainerCreateOptions` hands to
 * dockerode: every forbidden option ABSENT, every required option PRESENT. Because
 * the engine passes this exact object to `docker.createContainer` unmodified
 * (jobs.mjs), a guarantee proven here is a guarantee about the container that runs.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  buildContainerCreateOptions,
  imageDigestOf,
  jobNetworkName,
  jobVolumeName,
  parseSizeBytes,
  resolveClampLimits,
  SpecRejectedError,
} from '../src/clamp.mjs';

const JOB_ID = '11111111-1111-4111-8111-111111111111';
const DIGEST = 'sha256:1111111111111111111111111111111111111111111111111111111111111111';
const IMAGE = `ghcr.io/byte5ai/omadia-dev-runner@${DIGEST}`;
const LEASE = '2026-07-10T12:00:00.000Z';

/** @returns {import('../src/policyClient.mjs').DerivedJobPolicy} */
function policy(overrides = {}) {
  return { jobId: JOB_ID, image: IMAGE, env: {}, egressAllowlist: [], ...overrides };
}

/** Build the canonical clamped options with default limits. */
function build(overrides = {}) {
  return buildContainerCreateOptions({
    jobId: JOB_ID,
    policy: overrides.policy ?? policy(),
    leaseExpiresAt: LEASE,
    networkName: jobNetworkName(JOB_ID),
    volumeName: jobVolumeName(JOB_ID),
    createdBy: 'omadia-middleware',
    limits: resolveClampLimits({}),
    ...overrides,
  });
}

describe('buildContainerCreateOptions — REQUIRED clamp fields present', () => {
  const o = build();
  const hc = o.HostConfig ?? {};

  it('runs non-root as 1000:1000', () => assert.equal(o.User, '1000:1000'));
  it('pins the digest-pinned image verbatim', () => assert.equal(o.Image, IMAGE));
  it('works in /workspace', () => assert.equal(o.WorkingDir, '/workspace'));
  it('is read-only rootfs', () => assert.equal(hc.ReadonlyRootfs, true));
  it('drops ALL capabilities', () => assert.deepEqual(hc.CapDrop, ['ALL']));
  it('sets no-new-privileges', () => assert.deepEqual(hc.SecurityOpt, ['no-new-privileges:true']));
  it('is explicitly not privileged', () => assert.equal(hc.Privileged, false));
  it('caps memory and disables swap (MemorySwap == Memory)', () => {
    assert.equal(hc.Memory, 4 * 1024 ** 3);
    assert.equal(hc.MemorySwap, hc.Memory);
  });
  it('caps cpu at 2 (NanoCpus)', () => assert.equal(hc.NanoCpus, 2_000_000_000));
  it('caps process count (PidsLimit)', () => assert.equal(hc.PidsLimit, 512));
  it('caps open files (nofile soft==hard)', () => {
    assert.deepEqual(hc.Ulimits, [{ Name: 'nofile', Soft: 4096, Hard: 4096 }]);
  });
  it('never restarts', () => assert.deepEqual(hc.RestartPolicy, { Name: 'no' }));
  it('attaches ONLY to the per-job bridge, never host/default', () => {
    assert.equal(hc.NetworkMode, `omadia-job-${JOB_ID}`);
    assert.notEqual(hc.NetworkMode, 'host');
    assert.notEqual(hc.NetworkMode, 'bridge');
    assert.notEqual(hc.NetworkMode, 'default');
  });
  it('mounts ONLY the per-job workspace volume, no host path', () => {
    assert.deepEqual(hc.Binds, [`omadia-job-${JOB_ID}:/workspace`]);
  });
  it('gives /tmp a sized tmpfs WITHOUT noexec (npm needs exec in tmp)', () => {
    assert.equal(hc.Tmpfs?.['/tmp'], 'rw,size=512m');
    assert.ok(!/noexec/.test(hc.Tmpfs?.['/tmp'] ?? ''), 'noexec must NOT be set on /tmp');
  });
  it('labels the job for the reaper (jobId, createdBy, leaseExpiresAt)', () => {
    assert.equal(o.Labels?.['ai.omadia.dev.jobId'], JOB_ID);
    assert.equal(o.Labels?.['ai.omadia.dev.createdBy'], 'omadia-middleware');
    assert.equal(o.Labels?.['ai.omadia.dev.leaseExpiresAt'], LEASE);
  });
});

describe('buildContainerCreateOptions — FORBIDDEN options are absent by construction', () => {
  const o = build();
  const hc = /** @type {Record<string, unknown>} */ (o.HostConfig ?? {});

  // The clamp is an ALLOWLIST, not a scrub-list: the produced HostConfig contains
  // EXACTLY these keys and nothing else, so a dangerous field can never ride along.
  it('HostConfig has exactly the allowlisted keys — nothing else can appear', () => {
    const allowed = [
      'Binds',
      'CapDrop',
      'Memory',
      'MemorySwap',
      'NanoCpus',
      'NetworkMode',
      'PidsLimit',
      'Privileged',
      'ReadonlyRootfs',
      'RestartPolicy',
      'SecurityOpt',
      'Tmpfs',
      'Ulimits',
    ];
    assert.deepEqual(Object.keys(hc).sort(), allowed);
  });

  // Explicit per-field absence table — the properties an attacker's policy would
  // want are simply not there (undefined), never granted.
  for (const key of ['CapAdd', 'Devices', 'DeviceRequests', 'PidMode', 'IpcMode', 'UTSMode', 'Mounts', 'Sysctls', 'GroupAdd', 'CgroupParent', 'Dns']) {
    it(`does not set HostConfig.${key}`, () => assert.equal(hc[key], undefined));
  }

  it('never grants privileged, host namespaces, or a host network', () => {
    assert.notEqual(hc.Privileged, true);
    assert.notEqual(hc.PidMode, 'host');
    assert.notEqual(hc.IpcMode, 'host');
    assert.notEqual(hc.NetworkMode, 'host');
  });

  it('never leaves the rootfs writable', () => assert.notEqual(hc.ReadonlyRootfs, false));

  it('top-level options carry exactly the clamped keys', () => {
    assert.deepEqual(Object.keys(o).sort(), ['Env', 'HostConfig', 'Image', 'Labels', 'User', 'WorkingDir']);
  });
});

describe('buildContainerCreateOptions — env passes through as the already-clamped policy env', () => {
  it('serialises policy env to sorted KEY=VALUE, injecting nothing and dropping nothing', () => {
    const o = build({ policy: policy({ env: { OMADIA_JOB_ID: JOB_ID, HTTP_PROXY: 'http://p:3128', FOO: 'bar' } }) });
    assert.deepEqual(o.Env, ['FOO=bar', 'HTTP_PROXY=http://p:3128', `OMADIA_JOB_ID=${JOB_ID}`]);
  });

  it('an empty policy env yields an empty Env array', () => {
    assert.deepEqual(build().Env, []);
  });
});

describe('buildContainerCreateOptions — a forbidden image fails with spec_rejected, never launches', () => {
  it('rejects a floating tag (no digest) with a spec_rejected-shaped error', () => {
    assert.throws(
      () => build({ policy: policy({ image: 'ghcr.io/byte5ai/omadia-dev-runner:latest' }) }),
      (err) => {
        assert.ok(err instanceof SpecRejectedError);
        assert.equal(err.code, 'daemon.spec_rejected');
        assert.equal(err.reason, 'image_not_digest_pinned');
        return true;
      },
    );
  });

  it('rejects a stub/short digest that is not a real content address', () => {
    assert.throws(
      () => build({ policy: policy({ image: 'ghcr.io/x/y@sha256:abc' }) }),
      (err) => err instanceof SpecRejectedError && err.reason === 'image_bad_digest',
    );
  });
});

describe('resolveClampLimits — resource bounds are always present and env-tunable', () => {
  it('defaults to the §4 floor when nothing is set', () => {
    assert.deepEqual(resolveClampLimits({}), {
      memoryBytes: 4 * 1024 ** 3,
      nanoCpus: 2_000_000_000,
      pidsLimit: 512,
      tmpfsMb: 512,
      nofile: 4096,
    });
  });

  it('honours operator overrides (e.g. raising memory)', () => {
    const l = resolveClampLimits({ DEV_JOB_MEM: '8g', DEV_JOB_CPUS: '4', DEV_JOB_PIDS: '1024', DEV_JOB_TMPFS_MB: '256' });
    assert.equal(l.memoryBytes, 8 * 1024 ** 3);
    assert.equal(l.nanoCpus, 4_000_000_000);
    assert.equal(l.pidsLimit, 1024);
    assert.equal(l.tmpfsMb, 256);
  });

  it('never removes a limit: a garbage/zero value falls back to the floor', () => {
    const l = resolveClampLimits({ DEV_JOB_MEM: 'nonsense', DEV_JOB_CPUS: '0', DEV_JOB_PIDS: '-5' });
    assert.equal(l.memoryBytes, 4 * 1024 ** 3);
    assert.equal(l.nanoCpus, 2_000_000_000);
    assert.equal(l.pidsLimit, 512);
  });
});

describe('parseSizeBytes / naming / imageDigestOf helpers', () => {
  it('parses binary size suffixes', () => {
    assert.equal(parseSizeBytes('4g'), 4 * 1024 ** 3);
    assert.equal(parseSizeBytes('512m'), 512 * 1024 ** 2);
    assert.equal(parseSizeBytes('1024k'), 1024 * 1024);
    assert.equal(parseSizeBytes('1048576'), 1048576);
    assert.equal(parseSizeBytes('bad'), null);
    assert.equal(parseSizeBytes(undefined), null);
  });

  it('names the per-job network and volume from the UUID', () => {
    assert.equal(jobNetworkName(JOB_ID), `omadia-job-${JOB_ID}`);
    assert.equal(jobVolumeName(JOB_ID), `omadia-job-${JOB_ID}`);
  });

  it('extracts a digest, and returns undefined for a floating tag', () => {
    assert.equal(imageDigestOf(IMAGE), DIGEST);
    assert.equal(imageDigestOf('ghcr.io/x/y:latest'), undefined);
  });
});
