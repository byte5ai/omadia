import { strict as assert } from 'node:assert';
import http from 'node:http';
import { after, before, describe, it } from 'node:test';

import { __probeForTests as probe, waitForHealthyVersion } from '../src/health.mjs';

/** Deterministic clock so the timeout path never depends on wall time. */
function fakeClock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
  };
}

describe('waitForHealthyVersion (#432)', () => {
  it('passes once the NEW version is actually serving', async () => {
    const clock = fakeClock();
    let attempts = 0;
    const result = await waitForHealthyVersion({
      url: 'http://middleware:8080/health',
      expectVersion: 'v0.75.0',
      ...clock,
      probeImpl: async () => {
        attempts += 1;
        // The old build answers first — restarting takes a moment.
        return attempts < 3
          ? { ok: true, version: 'v0.74.0' }
          : { ok: true, version: 'v0.75.0' };
      },
    });

    assert.deepEqual(result, {
      ok: true,
      reason: 'version_match',
      observedVersion: 'v0.75.0',
    });
    assert.equal(attempts, 3);
  });

  it('does NOT pass while the old version is still answering', async () => {
    const clock = fakeClock();
    const result = await waitForHealthyVersion({
      url: 'http://middleware:8080/health',
      expectVersion: 'v0.75.0',
      timeoutMs: 30_000,
      ...clock,
      probeImpl: async () => ({ ok: true, version: 'v0.74.0' }),
    });

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'version_never_matched');
    assert.equal(result.observedVersion, 'v0.74.0');
  });

  it('reports unreachable separately from wrong-version', async () => {
    const clock = fakeClock();
    const result = await waitForHealthyVersion({
      url: 'http://middleware:8080/health',
      expectVersion: 'v0.75.0',
      timeoutMs: 10_000,
      ...clock,
      probeImpl: async () => ({ ok: false, version: null }),
    });

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'never_reachable');
  });

  it('accepts reachability alone for an unstamped (locally built) image', async () => {
    const clock = fakeClock();
    const logs = [];
    const result = await waitForHealthyVersion({
      url: 'http://middleware:8080/health',
      expectVersion: 'v0.75.0',
      ...clock,
      log: (m) => logs.push(m),
      probeImpl: async () => ({ ok: true, version: null }),
    });

    assert.equal(result.ok, true);
    assert.equal(result.reason, 'reachable_unstamped');
    assert.ok(
      logs.some((l) => l.includes('no version stamp')),
      'the weaker guarantee has to be visible in the step trail',
    );
  });
});

/** @param {http.Server} server @returns {Promise<number>} the bound port */
function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

// The middleware writes the answer to this probe, and the updater also sits on
// `omadia-control`. Following a `Location` would let the middleware aim one of
// the updater's requests at the Engine proxy. The stand-in "engine" answers
// like `GET /containers/json`: 200 with a JSON array, which the probe would
// otherwise take for an unstamped but healthy build.
describe('the health probe never follows a redirect', () => {
  const engineHits = [];
  let enginePort = 0;
  const engine = http.createServer((req, res) => {
    engineHits.push(`${req.method} ${req.url}`);
    res.setHeader('content-type', 'application/json');
    res.end('[]');
  });
  const middleware = http.createServer((req, res) => {
    res.statusCode = Number(new URL(req.url ?? '/', 'http://middleware').searchParams.get('status'));
    res.setHeader('location', `http://127.0.0.1:${enginePort}/containers/json?all=1`);
    res.end();
  });
  let healthUrl = '';

  before(async () => {
    enginePort = await listen(engine);
    healthUrl = `http://127.0.0.1:${await listen(middleware)}/health`;
  });
  after(() => {
    for (const server of [engine, middleware]) {
      server.closeAllConnections();
      server.close();
    }
  });

  for (const status of [301, 302, 303, 307, 308]) {
    it(`a ${status} to another server is not healthy and sends nothing there`, async () => {
      engineHits.length = 0;
      const result = await probe(`${healthUrl}?status=${status}`, 2_000);

      assert.equal(result.ok, false);
      assert.equal(result.version, null);
      assert.deepEqual(engineHits, [], 'the redirect target must not receive a request');
    });
  }

  it('keeps the gate closed and says why, once, in the step trail', async () => {
    engineHits.length = 0;
    const logs = [];
    const result = await waitForHealthyVersion({
      url: `${healthUrl}?status=302`,
      expectVersion: 'v0.75.0',
      timeoutMs: 10_000,
      ...fakeClock(),
      log: (m) => logs.push(m),
    });

    assert.deepEqual(result, { ok: false, reason: 'never_reachable', observedVersion: null });
    assert.deepEqual(engineHits, []);
    assert.equal(logs.filter((l) => l.includes('redirect')).length, 1);
  });
});
