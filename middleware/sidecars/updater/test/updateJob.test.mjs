import { strict as assert } from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, it } from 'node:test';

import { readVersion } from '../src/envFile.mjs';
import { createDockerEngine } from '../src/engine/docker.mjs';
import { detectComposeProject, runUpdate } from '../src/updateJob.mjs';

import { createFakeDocker, ops } from './_fakeDocker.mjs';

const SERVICES = {
  middleware: 'ghcr.io/byte5ai/omadia-middleware:v0.74.0',
  'web-ui': 'ghcr.io/byte5ai/omadia-web-ui:v0.74.0',
};

async function makeEnvFile(initial = 'VAULT_KEY=abc\nOMADIA_VERSION=v0.74.0\n') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'omadia-job-'));
  const file = path.join(dir, '.env');
  await fs.writeFile(file, initial, 'utf8');
  return file;
}

function makeConfig(envFilePath, overrides = {}) {
  return {
    services: ['middleware', 'web-ui'],
    selfService: 'updater',
    envFilePath,
    healthUrl: 'http://middleware:8080/health',
    healthUrls: {
      middleware: 'http://middleware:8080/health',
      'web-ui': 'http://web-ui:3000/health',
    },
    healthTimeoutMs: 1_000,
    ...overrides,
  };
}

describe('runUpdate (#432)', () => {
  let logs;
  const log = (m) => logs.push(m);

  beforeEach(() => {
    logs = [];
  });

  it('pulls every image BEFORE stopping anything', async () => {
    const docker = createFakeDocker({ services: SERVICES });
    const envFile = await makeEnvFile();

    const result = await runUpdate({
      engine: createDockerEngine({ docker, config: makeConfig(envFile), project: 'omadia' }),
      config: makeConfig(envFile),
      targetVersion: 'v0.75.0',
      project: 'omadia',
      log,
      healthWaiter: async () => ({ ok: true, reason: 'version_match', observedVersion: 'v0.75.0' }),
    });

    assert.equal(result.ok, true);
    const sequence = ops(docker);
    const lastPull = sequence.lastIndexOf('pull');
    const firstStop = sequence.indexOf('stop');
    assert.ok(lastPull !== -1 && firstStop !== -1);
    assert.ok(
      lastPull < firstStop,
      'a failing pull must be discovered while every old container is still running',
    );
  });

  it('aborts before touching containers when a pull fails, leaving the pin alone', async () => {
    const docker = createFakeDocker({ services: SERVICES, failPullFor: 'web-ui' });
    const envFile = await makeEnvFile();

    await assert.rejects(
      runUpdate({
        engine: createDockerEngine({ docker, config: makeConfig(envFile), project: 'omadia' }),
        config: makeConfig(envFile),
        targetVersion: 'v9.9.9',
        project: 'omadia',
        log,
      }),
      /manifest unknown/,
    );

    assert.ok(!ops(docker).includes('stop'), 'no container may be stopped');
    assert.equal(
      readVersion(await fs.readFile(envFile, 'utf8')),
      'v0.74.0',
      'the pin must not move when the update never started',
    );
  });

  it('pins the target version so a later `docker compose up -d` agrees', async () => {
    const docker = createFakeDocker({ services: SERVICES });
    const envFile = await makeEnvFile();

    await runUpdate({
      engine: createDockerEngine({ docker, config: makeConfig(envFile), project: 'omadia' }),
      config: makeConfig(envFile),
      targetVersion: 'v0.75.0',
      project: 'omadia',
      log,
      healthWaiter: async () => ({ ok: true, reason: 'version_match', observedVersion: 'v0.75.0' }),
    });

    assert.equal(readVersion(await fs.readFile(envFile, 'utf8')), 'v0.75.0');
  });

  it('rolls every container and the pin back when the health gate fails', async () => {
    const docker = createFakeDocker({ services: SERVICES });
    const envFile = await makeEnvFile();

    const result = await runUpdate({
      engine: createDockerEngine({ docker, config: makeConfig(envFile), project: 'omadia' }),
      config: makeConfig(envFile),
      targetVersion: 'v0.75.0',
      project: 'omadia',
      log,
      healthWaiter: async () => ({
        ok: false,
        reason: 'version_never_matched',
        observedVersion: 'v0.74.0',
      }),
    });

    assert.equal(result.ok, false);
    assert.equal(result.rolledBack, true);

    assert.equal(
      readVersion(await fs.readFile(envFile, 'utf8')),
      'v0.74.0',
      'a failed update must not leave the stack pinned to the version that failed',
    );

    // Both services are back on the old image, under their original names.
    const running = [...docker.containers.values()];
    const images = running.map((c) => c.Config.Image).sort();
    assert.deepEqual(images, [
      'ghcr.io/byte5ai/omadia-middleware:v0.74.0',
      'ghcr.io/byte5ai/omadia-web-ui:v0.74.0',
    ]);
    assert.deepEqual(
      running.map((c) => c.Name).sort(),
      ['/omadia-middleware-1', '/omadia-web-ui-1'],
    );
  });

  it('rolls back when a container fails to be recreated mid-flight', async () => {
    const docker = createFakeDocker({
      services: SERVICES,
      failCreateFor: 'omadia-web-ui:v0.75.0',
    });
    const envFile = await makeEnvFile();

    const result = await runUpdate({
      engine: createDockerEngine({ docker, config: makeConfig(envFile), project: 'omadia' }),
      config: makeConfig(envFile),
      targetVersion: 'v0.75.0',
      project: 'omadia',
      log,
      healthWaiter: async () => {
        throw new Error('health gate must not be reached');
      },
    });

    assert.equal(result.ok, false);
    assert.equal(result.rolledBack, true);
    assert.equal(readVersion(await fs.readFile(envFile, 'utf8')), 'v0.74.0');
    // The middleware, which HAD been recreated on the new tag, is back on old.
    const middleware = [...docker.containers.values()].find((c) =>
      c.Name.includes('middleware'),
    );
    assert.equal(middleware.Config.Image, 'ghcr.io/byte5ai/omadia-middleware:v0.74.0');
  });

  it('reports every phase in order and ends on `done` when the gate passes', async () => {
    const docker = createFakeDocker({ services: SERVICES });
    const envFile = await makeEnvFile();
    const phases = [];

    const result = await runUpdate({
      engine: createDockerEngine({ docker, config: makeConfig(envFile), project: 'omadia' }),
      config: makeConfig(envFile),
      targetVersion: 'v0.75.0',
      log,
      setPhase: (p) => phases.push(p),
      healthWaiter: async () => ({ ok: true, reason: 'version_match', observedVersion: 'v0.75.0' }),
    });

    assert.equal(result.ok, true);
    assert.equal(result.failure, undefined);
    assert.deepEqual(phases, ['resolve', 'preflight', 'pin', 'replace', 'health_gate', 'done']);
  });

  it('returns a structured health_gate failure the UI can decode without parsing text', async () => {
    const docker = createFakeDocker({ services: SERVICES });
    const envFile = await makeEnvFile();
    const phases = [];

    const result = await runUpdate({
      engine: createDockerEngine({ docker, config: makeConfig(envFile), project: 'omadia' }),
      config: makeConfig(envFile),
      targetVersion: 'v0.75.0',
      log,
      setPhase: (p) => phases.push(p),
      healthWaiter: async () => ({ ok: false, reason: 'never_reachable', observedVersion: null }),
    });

    assert.equal(result.ok, false);
    assert.equal(result.rolledBack, true);
    assert.deepEqual(result.failure, {
      kind: 'health_gate',
      service: 'middleware',
      reason: 'never_reachable',
      observedVersion: null,
    });
    // The human trail still carries the same verdict — the two must not drift.
    assert.match(
      result.error,
      /health gate failed for middleware: never_reachable \(observed version: none\)/,
    );
    assert.equal(phases.at(-1), 'rollback');
    assert.ok(phases.includes('health_gate'));
  });

  // THE GAP: before per-service gating, a web-ui that never came up was
  // invisible — the middleware answered with the new version, the gate was
  // satisfied, and the update was reported as landed with half the stack down.
  it('rolls back when a NON-middleware service fails its own health gate', async () => {
    const docker = createFakeDocker({ services: SERVICES });
    const envFile = await makeEnvFile();
    const asked = [];

    const result = await runUpdate({
      engine: createDockerEngine({ docker, config: makeConfig(envFile), project: 'omadia' }),
      config: makeConfig(envFile),
      targetVersion: 'v0.75.0',
      log,
      healthWaiter: async ({ url }) => {
        asked.push(url);
        return url.includes('web-ui')
          ? { ok: false, reason: 'never_reachable', observedVersion: null }
          : { ok: true, reason: 'version_match', observedVersion: 'v0.75.0' };
      },
    });

    assert.equal(result.ok, false);
    assert.equal(result.rolledBack, true);
    assert.deepEqual(result.failure, {
      kind: 'health_gate',
      service: 'web-ui',
      reason: 'never_reachable',
      observedVersion: null,
    });
    // Both were asked, in job order — the middleware's pass must not stand in
    // for the web-ui's.
    assert.deepEqual(asked, [
      'http://middleware:8080/health',
      'http://web-ui:3000/health',
    ]);
    // And the whole stack went back, not just the service that failed.
    assert.equal(
      (await fs.readFile(envFile, 'utf8')).includes('OMADIA_VERSION=v0.74.0'),
      true,
    );
  });

  it('stops at the first failing gate instead of burning a second timeout', async () => {
    const docker = createFakeDocker({ services: SERVICES });
    const envFile = await makeEnvFile();
    const asked = [];

    const result = await runUpdate({
      engine: createDockerEngine({ docker, config: makeConfig(envFile), project: 'omadia' }),
      config: makeConfig(envFile),
      targetVersion: 'v0.75.0',
      log,
      healthWaiter: async ({ url }) => {
        asked.push(url);
        return { ok: false, reason: 'never_reachable', observedVersion: null };
      },
    });

    assert.equal(result.ok, false);
    assert.deepEqual(asked, ['http://middleware:8080/health']);
  });

  // Silence would be the same lie in a smaller box: an operator reading the
  // trail must be able to tell "verified" from "not checked".
  it('says out loud when a service has no health URL to gate on', async () => {
    const docker = createFakeDocker({ services: SERVICES });
    const envFile = await makeEnvFile();

    const result = await runUpdate({
      engine: createDockerEngine({ docker, config: makeConfig(envFile), project: 'omadia' }),
      config: makeConfig(envFile, {
        healthUrls: { middleware: 'http://middleware:8080/health' },
      }),
      targetVersion: 'v0.75.0',
      log,
      healthWaiter: async () => ({ ok: true, reason: 'version_match', observedVersion: 'v0.75.0' }),
    });

    assert.equal(result.ok, true);
    assert.ok(
      logs.some((line) => /no health URL configured for web-ui/.test(line)),
      'the trail names the service that was not gated',
    );
  });

  it('names the service that could not be replaced in the failure', async () => {
    const docker = createFakeDocker({
      services: SERVICES,
      failCreateFor: 'omadia-web-ui:v0.75.0',
    });
    const envFile = await makeEnvFile();
    const phases = [];

    const result = await runUpdate({
      engine: createDockerEngine({ docker, config: makeConfig(envFile), project: 'omadia' }),
      config: makeConfig(envFile),
      targetVersion: 'v0.75.0',
      log,
      setPhase: (p) => phases.push(p),
      healthWaiter: async () => {
        throw new Error('health gate must not be reached');
      },
    });

    assert.deepEqual(result.failure, { kind: 'replace', service: 'web-ui' });
    assert.deepEqual(phases, ['resolve', 'preflight', 'pin', 'replace', 'rollback']);
  });

  it('works without a setPhase hook (older callers)', async () => {
    const docker = createFakeDocker({ services: SERVICES });
    const envFile = await makeEnvFile();
    const result = await runUpdate({
      engine: createDockerEngine({ docker, config: makeConfig(envFile), project: 'omadia' }),
      config: makeConfig(envFile),
      targetVersion: 'v0.75.0',
      log,
      healthWaiter: async () => ({ ok: true, reason: 'version_match', observedVersion: 'v0.75.0' }),
    });
    assert.equal(result.ok, true);
  });

  it('refuses a protected service even if it is configured', async () => {
    const docker = createFakeDocker({ services: { postgres: 'pgvector/pgvector:pg17' } });
    const envFile = await makeEnvFile();

    await assert.rejects(
      runUpdate({
        engine: createDockerEngine({ docker, config: makeConfig(envFile, { services: ['postgres'] }), project: 'omadia' }),
        config: makeConfig(envFile, { services: ['postgres'] }),
        targetVersion: 'v0.75.0',
        project: 'omadia',
        log,
      }),
      /protected service "postgres"/,
    );
    assert.ok(!ops(docker).includes('pull'));
  });

  it('refuses to update a scaled service rather than replacing one replica', async () => {
    const docker = createFakeDocker({ services: SERVICES });
    // Two containers claiming the same compose service.
    docker.containers.set('dup', {
      Id: 'dup',
      Name: '/omadia-middleware-2',
      Config: {
        Image: SERVICES.middleware,
        Env: [],
        Labels: {
          'com.docker.compose.project': 'omadia',
          'com.docker.compose.service': 'middleware',
        },
      },
      HostConfig: {},
      NetworkSettings: { Networks: {} },
    });
    const envFile = await makeEnvFile();

    await assert.rejects(
      runUpdate({
        engine: createDockerEngine({ docker, config: makeConfig(envFile, { services: ['middleware'] }), project: 'omadia' }),
        config: makeConfig(envFile, { services: ['middleware'] }),
        targetVersion: 'v0.75.0',
        project: 'omadia',
        log,
      }),
      /scaled services are not supported/,
    );
  });

  it('fails loudly when the env file cannot be written', async () => {
    const docker = createFakeDocker({ services: SERVICES });

    await assert.rejects(
      runUpdate({
        engine: createDockerEngine({ docker, config: makeConfig('/nonexistent-dir/.env'), project: 'omadia' }),
        config: makeConfig('/nonexistent-dir/.env'),
        targetVersion: 'v0.75.0',
        project: 'omadia',
        log,
      }),
      /refusing to update/,
    );
    assert.ok(
      !ops(docker).includes('stop'),
      'an unwritable pin must abort before the stack is touched',
    );
  });
});

describe('detectComposeProject', () => {
  it('reads the project from the updater own container labels', async () => {
    const docker = createFakeDocker({ services: { updater: 'omadia-updater:dev' } });
    const self = [...docker.containers.values()][0];
    const project = await detectComposeProject(docker, self.Id);
    assert.equal(project, 'omadia');
  });

  it('asks for explicit config when the label is missing', async () => {
    const docker = {
      async inspectContainer() {
        return { Config: { Labels: {} } };
      },
    };
    await assert.rejects(
      detectComposeProject(docker, 'abc'),
      /UPDATER_COMPOSE_PROJECT/,
    );
  });
});
