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
      runUpdateImpl: async ({ targetVersion, log }) => {
        log(`fake update to ${targetVersion}`);
        // Hold the job open so the in-progress assertions are not racing a
        // job that already finished.
        await started;
        return { ok: true, rolledBack: false };
      },
    });
    server = created.server;
    await new Promise((r) => server.listen(0, r));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    resolveStarted();
    await new Promise((r) => server.close(r));
  });

  const auth = { authorization: `Bearer ${TOKEN}` };

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

  it('404s an unknown route', async () => {
    const res = await fetch(`${base}/anything`, { headers: auth });
    assert.equal(res.status, 404);
  });
});
