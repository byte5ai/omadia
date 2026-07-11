/**
 * Epic #470 W1 — `dockerOptionsFromEnv` scheme/TLS clamp (round-3 finding).
 * The daemon talks to dind over tcp+TLS ONLY: a host `unix://` socket, a plaintext
 * `http://`, an `ssh://` tunnel, or a Windows `npipe://` are each refused at boot,
 * and TLS verify + a readable cert path are mandatory.
 */

import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { dockerOptionsFromEnv } from '../src/jobs.mjs';

/** A directory holding readable {ca,cert,key}.pem. */
function makeCertDir() {
  const dir = mkdtempSync(join(tmpdir(), 'dev-runner-certs-'));
  for (const f of ['ca.pem', 'cert.pem', 'key.pem']) writeFileSync(join(dir, f), 'test-pem');
  return dir;
}

describe('dockerOptionsFromEnv — DOCKER_HOST scheme clamp', () => {
  /** @type {string[]} */
  const dirs = [];
  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
  });

  it('refuses a missing DOCKER_HOST', () => {
    assert.throws(() => dockerOptionsFromEnv({}), /DOCKER_HOST is not set/);
  });

  it('refuses every non-tcp scheme, naming the offending value', () => {
    const certDir = makeCertDir();
    dirs.push(certDir);
    const base = { DOCKER_TLS_VERIFY: '1', DOCKER_CERT_PATH: certDir };
    for (const host of [
      'unix:///var/run/docker.sock',
      'http://dev-dind:2375',
      'https://dev-dind:2376',
      'ssh://user@dev-dind',
      'npipe:////./pipe/docker_engine',
    ]) {
      assert.throws(
        () => dockerOptionsFromEnv({ ...base, DOCKER_HOST: host }),
        (err) => err instanceof Error && err.message.includes('tcp://') && err.message.includes(host),
        `${host} must be refused`,
      );
    }
  });

  it('refuses a tcp host with no explicit port', () => {
    const certDir = makeCertDir();
    dirs.push(certDir);
    assert.throws(
      () => dockerOptionsFromEnv({ DOCKER_HOST: 'tcp://dev-dind', DOCKER_TLS_VERIFY: '1', DOCKER_CERT_PATH: certDir }),
      /explicit port/,
    );
  });

  it('requires DOCKER_TLS_VERIFY=1', () => {
    const certDir = makeCertDir();
    dirs.push(certDir);
    assert.throws(
      () => dockerOptionsFromEnv({ DOCKER_HOST: 'tcp://dev-dind:2376', DOCKER_CERT_PATH: certDir }),
      /DOCKER_TLS_VERIFY=1/,
    );
  });

  it('requires DOCKER_CERT_PATH', () => {
    assert.throws(
      () => dockerOptionsFromEnv({ DOCKER_HOST: 'tcp://dev-dind:2376', DOCKER_TLS_VERIFY: '1' }),
      /DOCKER_CERT_PATH/,
    );
  });

  it('fails with a clear message when the cert files are unreadable', () => {
    assert.throws(
      () =>
        dockerOptionsFromEnv({
          DOCKER_HOST: 'tcp://dev-dind:2376',
          DOCKER_TLS_VERIFY: '1',
          DOCKER_CERT_PATH: '/no/such/cert/dir',
        }),
      /DOCKER_CERT_PATH is not readable/,
    );
  });

  it('accepts a tcp+TLS endpoint and returns https dockerode options', () => {
    const certDir = makeCertDir();
    dirs.push(certDir);
    const opts = dockerOptionsFromEnv({
      DOCKER_HOST: 'tcp://dev-dind:2376',
      DOCKER_TLS_VERIFY: '1',
      DOCKER_CERT_PATH: certDir,
    });
    assert.equal(opts.host, 'dev-dind');
    assert.equal(opts.port, 2376);
    assert.equal(opts.protocol, 'https');
    assert.ok(opts.ca && opts.cert && opts.key, 'certs are loaded');
  });
});
