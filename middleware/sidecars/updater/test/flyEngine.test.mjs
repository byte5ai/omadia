import { strict as assert } from 'node:assert';
import { beforeEach, describe, it } from 'node:test';

import { createFlyEngine } from '../src/engine/fly.mjs';
import { runUpdate } from '../src/updateJob.mjs';

import { createFakeFlyApi, flyOps } from './_fakeFlyApi.mjs';

/**
 * #696 — the Fly executor.
 *
 * The headline assertion in this file is the config round trip: Fly's update
 * endpoint takes a REQUIRED `config` object that REPLACES the machine
 * configuration, so an engine that builds that object itself silently destroys
 * the volume mount, the health checks, the services and the env. It is the
 * same bug class as Docker's merged `Config.Env` in #692, and it is the one
 * mistake in this port that would be catastrophic and invisible.
 */

const CONFIG = {
  engine: 'fly',
  services: ['middleware', 'web-ui'],
  selfService: 'updater',
  flyApps: {
    middleware: 'omadia-middleware-x',
    'web-ui': 'omadia-web-ui-x',
  },
  healthUrl: 'https://omadia-middleware-x.fly.dev/health',
  healthTimeoutMs: 1_000,
};

const ok = async () => ({ exists: true });

describe('fly engine — resolving targets', () => {
  it('finds the single machine of an app and its image', async () => {
    const api = createFakeFlyApi();
    const engine = createFlyEngine({ config: CONFIG, api, manifestCheck: ok });

    const target = await engine.resolveTarget('middleware');

    assert.equal(target.service, 'middleware');
    assert.equal(target.currentImage, 'ghcr.io/byte5ai/omadia-middleware:v0.74.0');
    assert.equal(target.repo, 'ghcr.io/byte5ai/omadia-middleware');
    assert.equal(target.handle.app, 'omadia-middleware-x');
  });

  it('refuses a service with no Fly app configured', async () => {
    const api = createFakeFlyApi();
    const engine = createFlyEngine({
      config: { ...CONFIG, flyApps: {} },
      api,
      manifestCheck: ok,
    });
    await assert.rejects(engine.resolveTarget('middleware'), /no Fly app configured/);
  });

  it('refuses a scaled app rather than replacing one machine of several', async () => {
    const api = createFakeFlyApi();
    const app = 'omadia-middleware-x';
    const original = api.machines.get(app);
    api.listMachines = async () => [original, { ...original, id: 'm99' }];
    const engine = createFlyEngine({ config: CONFIG, api, manifestCheck: ok });

    await assert.rejects(engine.resolveTarget('middleware'), /scaled apps are not supported/);
  });

  it('ignores destroyed machines when counting', async () => {
    const api = createFakeFlyApi();
    const original = api.machines.get('omadia-middleware-x');
    api.listMachines = async () => [{ ...original, id: 'm-old', state: 'destroyed' }, original];
    const engine = createFlyEngine({ config: CONFIG, api, manifestCheck: ok });

    const target = await engine.resolveTarget('middleware');
    assert.equal(target.handle.machineId, original.id);
  });
});

describe('fly engine — replacing a machine', () => {
  let api;
  let engine;
  const logs = [];

  beforeEach(() => {
    logs.length = 0;
    api = createFakeFlyApi();
    engine = createFlyEngine({ config: CONFIG, api, manifestCheck: ok });
  });

  it('changes ONLY the image and preserves everything else', async () => {
    const target = await engine.resolveTarget('middleware');
    const before = JSON.parse(JSON.stringify(api.machines.get('omadia-middleware-x').config));

    await engine.replace(target, 'ghcr.io/byte5ai/omadia-middleware:v0.75.0', (m) => logs.push(m));

    const sent = api.calls.find((c) => c.op === 'update').config;
    assert.equal(sent.image, 'ghcr.io/byte5ai/omadia-middleware:v0.75.0');
    // The fields a hand-built request body would have dropped.
    assert.deepEqual(sent.mounts, before.mounts, 'the volume mount must survive');
    assert.deepEqual(sent.checks, before.checks, 'health checks must survive');
    assert.deepEqual(sent.services, before.services, 'services must survive');
    assert.deepEqual(sent.env, before.env, 'env must survive');
    assert.deepEqual(sent.restart, before.restart, 'restart policy must survive');
    assert.deepEqual(sent.guest, before.guest, 'machine size must survive');
  });

  it('reads the machine fresh before writing, and sends current_version', async () => {
    const target = await engine.resolveTarget('middleware');
    await engine.replace(target, 'img:2', (m) => logs.push(m));

    const sequence = flyOps(api);
    assert.ok(
      sequence.indexOf('get') < sequence.indexOf('update'),
      'the config must come from a read, never be built from scratch',
    );
    // Optimistic concurrency: a change made by anyone else since the read
    // makes this update fail loudly instead of clobbering theirs.
    const update = api.calls.find((c) => c.op === 'update');
    assert.equal(update.currentVersion, `01HVERSION${target.handle.machineId}`);
  });

  it('takes a lease first, waits for the machine to start, then releases', async () => {
    const target = await engine.resolveTarget('middleware');
    await engine.replace(target, 'img:2', (m) => logs.push(m));

    const sequence = flyOps(api);
    assert.ok(sequence.indexOf('lease') < sequence.indexOf('update'));
    assert.ok(sequence.indexOf('update') < sequence.indexOf('wait'));
    // The lease must be handed back last, not abandoned: it would keep
    // blocking writes for the rest of its TTL otherwise.
    assert.equal(sequence[sequence.length - 1], 'release');
    assert.equal(api.leaseHeld('omadia-middleware-x'), null);
  });

  it('sends the lease nonce with the update, or Fly rejects its own lease', async () => {
    const target = await engine.resolveTarget('middleware');
    await engine.replace(target, 'img:2', (m) => logs.push(m));

    // The regression this guards: the nonce was declared in updateMachine's
    // signature but threaded from nowhere, so every real update came back
    // 409 "lease currently held by …" and rolled back.
    const update = api.calls.find((c) => c.op === 'update');
    const lease = api.calls.find((c) => c.op === 'lease');
    assert.equal(update.leaseNonce, `nonce-${lease.id}`);
  });

  it('releases the lease even when the update fails', async () => {
    const failing = createFakeFlyApi({ failUpdateFor: 'boom' });
    const e = createFlyEngine({ config: CONFIG, api: failing, manifestCheck: ok });
    const target = await e.resolveTarget('middleware');

    await assert.rejects(() => e.replace(target, 'boom:1', (m) => logs.push(m)));

    // Without this the rollback that follows a failed update hits 409 too,
    // and the machine stays locked against `fly deploy` for the full TTL.
    assert.ok(flyOps(failing).includes('release'));
    assert.equal(failing.leaseHeld('omadia-middleware-x'), null);
  });

  it('continues without a lease rather than refusing to update', async () => {
    const withoutLease = createFakeFlyApi({ leaseThrows: true });
    const e = createFlyEngine({ config: CONFIG, api: withoutLease, manifestCheck: ok });
    const target = await e.resolveTarget('middleware');

    await e.replace(target, 'img:2', (m) => logs.push(m));

    assert.ok(flyOps(withoutLease).includes('update'));
    assert.ok(logs.some((l) => l.includes('could not acquire a lease')));
  });
});

describe('fly engine — the pin it cannot write', () => {
  it('reports that the version pin is not persistable', async () => {
    const engine = createFlyEngine({ config: CONFIG, api: createFakeFlyApi(), manifestCheck: ok });
    assert.equal(engine.canPersistPin, false);
    assert.equal(await engine.pin('v0.75.0'), null);
    assert.equal(engine.pinDescription(), null);
  });
});

describe('fly engine — end to end through runUpdate', () => {
  const log = () => {};

  it('updates both apps and passes the health gate', async () => {
    const api = createFakeFlyApi();
    const engine = createFlyEngine({ config: CONFIG, api, manifestCheck: ok });

    const result = await runUpdate({
      engine,
      config: CONFIG,
      targetVersion: 'v0.75.0',
      log,
      healthWaiter: async () => ({ ok: true, reason: 'version_match', observedVersion: 'v0.75.0' }),
    });

    assert.equal(result.ok, true);
    assert.equal(
      api.machines.get('omadia-middleware-x').config.image,
      'ghcr.io/byte5ai/omadia-middleware:v0.75.0',
    );
    assert.equal(
      api.machines.get('omadia-web-ui-x').config.image,
      'ghcr.io/byte5ai/omadia-web-ui:v0.75.0',
    );
  });

  it('aborts before touching any machine when the tag is missing', async () => {
    const api = createFakeFlyApi();
    const engine = createFlyEngine({
      config: CONFIG,
      api,
      manifestCheck: async (_repo, tag) =>
        tag === 'v9.9.9' ? { exists: false, reason: 'tag_not_found' } : { exists: true },
    });

    await assert.rejects(
      runUpdate({ engine, config: CONFIG, targetVersion: 'v9.9.9', log }),
      /is not available \(tag_not_found\)/,
    );
    assert.ok(
      !flyOps(api).includes('update'),
      'Fly would only discover a bad tag after the first machine is already moving',
    );
  });

  it('rolls both apps back when the health gate fails', async () => {
    const api = createFakeFlyApi();
    const engine = createFlyEngine({ config: CONFIG, api, manifestCheck: ok });

    const result = await runUpdate({
      engine,
      config: CONFIG,
      targetVersion: 'v0.75.0',
      log,
      healthWaiter: async () => ({
        ok: false,
        reason: 'version_never_matched',
        observedVersion: 'v0.74.0',
      }),
    });

    assert.equal(result.rolledBack, true);
    assert.equal(
      api.machines.get('omadia-middleware-x').config.image,
      'ghcr.io/byte5ai/omadia-middleware:v0.74.0',
    );
    assert.equal(
      api.machines.get('omadia-web-ui-x').config.image,
      'ghcr.io/byte5ai/omadia-web-ui:v0.74.0',
    );
  });

  it('rolls back the app it already moved when the second update fails', async () => {
    const api = createFakeFlyApi({ failUpdateFor: 'omadia-web-ui:v0.75.0' });
    const engine = createFlyEngine({ config: CONFIG, api, manifestCheck: ok });

    const result = await runUpdate({
      engine,
      config: CONFIG,
      targetVersion: 'v0.75.0',
      log,
      healthWaiter: async () => {
        throw new Error('the health gate must not be reached');
      },
    });

    assert.equal(result.ok, false);
    assert.equal(result.rolledBack, true);
    assert.equal(
      api.machines.get('omadia-middleware-x').config.image,
      'ghcr.io/byte5ai/omadia-middleware:v0.74.0',
    );
  });

  it('refuses a protected service before contacting Fly at all', async () => {
    const api = createFakeFlyApi();
    const engine = createFlyEngine({ config: CONFIG, api, manifestCheck: ok });

    await assert.rejects(
      runUpdate({
        engine,
        config: { ...CONFIG, services: ['postgres'] },
        targetVersion: 'v0.75.0',
        log,
      }),
      /protected service "postgres"/,
    );
    assert.deepEqual(flyOps(api), []);
  });
});
