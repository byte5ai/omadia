import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';

import { createServer } from '../src/server.mjs';

const TOKEN = 'k'.repeat(32);

const CONFIG = {
  token: TOKEN,
  dockerApiUrl: 'http://unused',
  services: ['middleware'],
  composeProject: 'omadia',
  envFilePath: '/tmp/nonexistent-.env',
  healthUrl: 'http://middleware:8080/health',
  port: 0,
  healthTimeoutMs: 1_000,
  selfService: 'updater',
};

describe('updater HTTP control plane (#432)', () => {
  let base;
  let server;
  let started;
  let resolveStarted;

  before(async () => {
    started = new Promise((r) => { resolveStarted = r; });
    const created = createServer({
      config: CONFIG,
      docker: {},
      detectProjectImpl: async () => 'omadia',
      // No network in tests: the registry answer is injected, so the route's
      // own wiring is what is under test, not GHCR's availability.
      manifestCheck: async () => ({ exists: true }),
      engine: {
        kind: 'docker',
        canPersistPin: true,
        resolveTarget: async (service) => ({
          service,
          currentImage: 'ghcr.io/byte5ai/omadia-middleware:v0.136.2@sha256:abc',
          repo: 'ghcr.io/byte5ai/omadia-middleware',
          handle: {},
        }),
        preflight: async () => {},
        pin: async () => null,
        restorePin: async () => {},
        pinDescription: () => CONFIG.envFilePath,
        replace: async () => {},
      },
      runUpdateImpl: async ({ targetVersion, log, setPhase }) => {
        log(`fake update to ${targetVersion}`);
        setPhase('health_gate');
        // Hold the job open so the in-progress assertions are not racing a
        // job that already finished.
        await started;
        return {
          ok: false,
          rolledBack: true,
          error: 'health gate failed: never_reachable (observed version: none)',
          failure: { kind: 'health_gate', reason: 'never_reachable', observedVersion: null },
        };
      },
    });
    server = created.server;
    // Bind IPv4 loopback explicitly so the reserved port is the one `base` dials.
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    resolveStarted();
    await new Promise((r) => server.close(r));
  });

  const auth = { authorization: `Bearer ${TOKEN}` };

  it('answers /preflight without touching anything', async () => {
    const res = await fetch(`${base}/preflight?targetVersion=v0.140.1`, {
      headers: auth,
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.targetVersion, 'v0.140.1');
    assert.equal(body.ok, true);
    assert.equal(
      body.images[0].image,
      'ghcr.io/byte5ai/omadia-middleware:v0.140.1',
    );
  });

  it('rejects a floating tag on /preflight', async () => {
    const res = await fetch(`${base}/preflight?targetVersion=latest`, {
      headers: auth,
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, 'invalid_target_version');
  });

  it('requires a token for /preflight', async () => {
    const res = await fetch(`${base}/preflight?targetVersion=v0.140.1`);
    assert.equal(res.status, 401);
  });

  it('serves /healthz without a token (compose healthcheck)', async () => {
    const res = await fetch(`${base}/healthz`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  });

  it('rejects every control route without a token', async () => {
    for (const [path, init] of [
      ['/status', { method: 'GET' }],
      ['/update', { method: 'POST', body: '{"targetVersion":"v1.0.0"}' }],
    ]) {
      const res = await fetch(`${base}${path}`, init);
      assert.equal(res.status, 401, `${path} must be gated`);
    }
  });

  it('rejects a wrong token', async () => {
    const res = await fetch(`${base}/status`, {
      headers: { authorization: `Bearer ${'z'.repeat(32)}` },
    });
    assert.equal(res.status, 401);
  });

  it('reports idle before anything is asked of it', async () => {
    const res = await fetch(`${base}/status`, { headers: auth });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.state, 'idle');
    assert.equal(body.targetVersion, null);
    assert.equal(body.phase, null);
    assert.equal(body.failure, null);
  });

  it('rejects a floating target tag', async () => {
    const res = await fetch(`${base}/update`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ targetVersion: 'latest' }),
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, 'invalid_target_version');
  });

  it('accepts a release tag with 202 and moves to updating', async () => {
    const res = await fetch(`${base}/update`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ targetVersion: 'v0.75.0' }),
    });
    assert.equal(res.status, 202);
    assert.deepEqual(await res.json(), { accepted: true, targetVersion: 'v0.75.0' });

    // The response is deliberately returned BEFORE the work runs; give the
    // detached job a tick to flip the state.
    await new Promise((r) => setTimeout(r, 20));
    const status = await (await fetch(`${base}/status`, { headers: auth })).json();
    assert.equal(status.state, 'updating');
    assert.equal(status.targetVersion, 'v0.75.0');
    assert.equal(status.phase, 'health_gate', 'the job phase is exposed while in flight');
    assert.equal(status.failure, null);
  });

  it('refuses a second update while one is in flight', async () => {
    const res = await fetch(`${base}/update`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ targetVersion: 'v0.76.0' }),
    });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).error, 'update_in_progress');
  });

  it('exposes the structured failure once the job has rolled back', async () => {
    resolveStarted();
    await new Promise((r) => setTimeout(r, 20));
    const status = await (await fetch(`${base}/status`, { headers: auth })).json();
    assert.equal(status.state, 'rolled_back');
    assert.deepEqual(status.failure, {
      kind: 'health_gate',
      reason: 'never_reachable',
      observedVersion: null,
    });
    assert.match(status.error, /never_reachable/);
    assert.ok(status.finishedAt, 'finishedAt is stamped');
  });

  it('404s an unknown route', async () => {
    const res = await fetch(`${base}/anything`, { headers: auth });
    assert.equal(res.status, 404);
  });
});
