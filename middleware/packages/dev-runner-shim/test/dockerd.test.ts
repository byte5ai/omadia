/**
 * Epic #470 W5 — the opt-in Docker-in-Docker start hook (spec §8).
 *
 * The decision matrix, without launching a real daemon (the launcher is a seam):
 *   - no capability            → nothing starts
 *   - capability + DOCKER_HOST  → the daemon sidecar owns it; nothing starts here
 *   - capability + no DOCKER_HOST → Fly path; the shim starts in-VM dockerd
 */

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { maybeStartDockerd, type DockerInJobCapableSpec } from '../src/dockerd.js';

const withDocker: DockerInJobCapableSpec = { capabilities: { dockerInJob: true } };
const withoutDocker: DockerInJobCapableSpec = { capabilities: { dockerInJob: false } };

describe('maybeStartDockerd — W5 dockerInJob dispatch', () => {
  it('does nothing when the repo did not opt in', async () => {
    let calls = 0;
    const res = await maybeStartDockerd(withoutDocker, {
      env: {},
      startDockerd: async () => {
        calls += 1;
      },
    });
    assert.deepEqual(res, { started: false, reason: 'not_requested' });
    assert.equal(calls, 0);
  });

  it('does nothing when a daemon sidecar already wired DOCKER_HOST (Docker backend)', async () => {
    let calls = 0;
    const res = await maybeStartDockerd(withDocker, {
      env: { DOCKER_HOST: 'tcp://dind:2376' },
      startDockerd: async () => {
        calls += 1;
      },
    });
    assert.deepEqual(res, { started: false, reason: 'sidecar' });
    assert.equal(calls, 0, 'the shim must not start a second dockerd over the sidecar');
  });

  it('starts in-VM dockerd when the flag is set and no DOCKER_HOST exists (Fly backend)', async () => {
    let calls = 0;
    const res = await maybeStartDockerd(withDocker, {
      env: {},
      startDockerd: async () => {
        calls += 1;
      },
    });
    assert.deepEqual(res, { started: true, reason: 'in_vm' });
    assert.equal(calls, 1);
  });

  it('treats a blank DOCKER_HOST as absent (Fly path)', async () => {
    let calls = 0;
    const res = await maybeStartDockerd(withDocker, {
      env: { DOCKER_HOST: '   ' },
      startDockerd: async () => {
        calls += 1;
      },
    });
    assert.equal(res.reason, 'in_vm');
    assert.equal(calls, 1);
  });
});
