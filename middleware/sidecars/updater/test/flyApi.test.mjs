/**
 * Wire-level tests for the Fly Machines client.
 *
 * WHY THESE EXIST. `flyEngine.test.mjs` drives a fake API object, so it can
 * only prove that the engine *passes* a lease nonce. It cannot prove the
 * client puts it on the wire — and that gap is precisely where the bug lived:
 * `updateMachine` declared `leaseNonce` in its signature and never sent it, so
 * every real update came back `409 lease currently held by …` and rolled back
 * while 263 lines of green tests said otherwise.
 *
 * These tests therefore assert against the ORACLE — the bytes an HTTP server
 * actually receives — not against a value stored in a mock.
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, it } from 'node:test';

import { createFlyApi } from '../src/flyApi.mjs';

/** Requests the stub server saw, newest last. */
const seen = [];
let server;
let baseUrl;

/**
 * Stub behaviour the individual tests steer.
 *
 * `machineStates` is consumed one entry per `GET …/machines/<id>` so a test can
 * say "not started yet, not started yet, started" and assert that the client
 * keeps waiting instead of giving up after one round.
 */
let machineStates = [];
/** Status code the `/wait` endpoint answers with. Fly 400s on timeout > 60. */
let waitStatus = 200;

function resetStub() {
  seen.length = 0;
  machineStates = [];
  waitStatus = 200;
}

before(async () => {
  server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      });

      if (req.url.includes('/wait?')) {
        const timeout = Number(new URL(req.url, 'http://x').searchParams.get('timeout'));
        // Mirror the real API's hard ceiling rather than accepting anything.
        if (timeout > 60 || timeout < 1) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              error:
                'invalid_argument: invalid WaitMachineRequest.Timeout: value must be inside range [1s, 1m0s]',
            }),
          );
          return;
        }
        res.writeHead(waitStatus, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      // A machine read: hand out the next scripted state, keeping the last.
      if (/\/machines\/[^/?]+$/.test(req.url) && req.method === 'GET') {
        const state = machineStates.length > 1 ? machineStates.shift() : machineStates[0];
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'm1', state: state ?? 'started', config: {} }));
        return;
      }

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: { nonce: 'nonce-from-fly' } }));
    });
  });
  await new Promise((resolve) => {
    // Bind an explicit IPv4 host: `listen(0)` alone can land on IPv6-only and
    // the client would dial a port nothing reserved.
    server.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

const api = () => createFlyApi({ baseUrl, tokenFor: () => 'tok-abc', timeoutMs: 5_000 });

const lastRequest = () => seen[seen.length - 1];

describe('flyApi — lease nonce on the wire', () => {
  it('sends fly-machine-lease-nonce when updating a leased machine', async () => {
    await api().updateMachine('app1', 'm1', {
      config: { image: 'img:2' },
      currentVersion: 'v1',
      leaseNonce: 'nonce-xyz',
    });

    const req = lastRequest();
    assert.equal(req.method, 'POST');
    assert.equal(req.headers['fly-machine-lease-nonce'], 'nonce-xyz');
  });

  it('omits the header when there is no lease', async () => {
    await api().updateMachine('app1', 'm1', { config: { image: 'img:2' } });

    assert.equal(lastRequest().headers['fly-machine-lease-nonce'], undefined);
  });

  it('keeps auth and content-type alongside the nonce', async () => {
    await api().updateMachine('app1', 'm1', {
      config: { image: 'img:3' },
      leaseNonce: 'nonce-xyz',
    });

    const req = lastRequest();
    assert.equal(req.headers.authorization, 'Bearer tok-abc');
    assert.equal(req.headers['content-type'], 'application/json');
    assert.equal(req.headers['fly-machine-lease-nonce'], 'nonce-xyz');
  });

  it('sends the config and current_version in the body, not the nonce', async () => {
    await api().updateMachine('app1', 'm1', {
      config: { image: 'img:4', mounts: [{ volume: 'vol_1' }] },
      currentVersion: 'inst-9',
      leaseNonce: 'nonce-xyz',
    });

    const body = JSON.parse(lastRequest().body);
    assert.deepEqual(body.config, { image: 'img:4', mounts: [{ volume: 'vol_1' }] });
    assert.equal(body.current_version, 'inst-9');
    assert.equal(body.leaseNonce, undefined);
  });

  it('releases a lease with DELETE and the nonce', async () => {
    await api().releaseLease('app1', 'm1', 'nonce-xyz');

    const req = lastRequest();
    assert.equal(req.method, 'DELETE');
    assert.match(req.url, /\/v1\/apps\/app1\/machines\/m1\/lease$/);
    assert.equal(req.headers['fly-machine-lease-nonce'], 'nonce-xyz');
  });

  it('reads the nonce out of the lease response envelope', async () => {
    const nonce = await api().acquireLease('app1', 'm1', 300);

    assert.equal(nonce, 'nonce-from-fly');
    assert.match(lastRequest().url, /\/lease\?ttl=300$/);
  });
});

describe('flyApi — waiting for a machine state', () => {
  const waitRequests = () => seen.filter((r) => r.url.includes('/wait?'));
  const timeoutsAsked = () =>
    waitRequests().map((r) => Number(new URL(r.url, 'http://x').searchParams.get('timeout')));

  it('never asks for more than Fly allows, even with a larger budget', async () => {
    resetStub();
    machineStates = ['started'];

    await api().waitForState('app1', 'm1', 'started', 120);

    // The regression: a 120s default was sent verbatim and Fly answered
    // `400 invalid WaitMachineRequest.Timeout … [1s, 1m0s]`, so the update
    // step that followed never ran and the whole job rolled back.
    assert.ok(timeoutsAsked().length > 0, 'it must actually call /wait');
    for (const t of timeoutsAsked()) {
      assert.ok(t >= 1 && t <= 60, `timeout ${t} is outside Fly's [1s, 60s]`);
    }
  });

  it('keeps waiting until the machine reports the state', async () => {
    resetStub();
    machineStates = ['starting', 'starting', 'started'];

    await api().waitForState('app1', 'm1', 'started', 180);

    assert.ok(
      waitRequests().length >= 2,
      'a single 60s slice cannot cover a longer budget — it must re-issue',
    );
  });

  it('gives up with a clear error when the budget is spent', async () => {
    resetStub();
    machineStates = ['starting'];

    await assert.rejects(
      () => api().waitForState('app1', 'm1', 'started', 1),
      /did not reach "started" within 1s/,
    );
  });

  it('survives a /wait that errors, as long as the machine got there', async () => {
    resetStub();
    waitStatus = 500;
    machineStates = ['started'];

    // A failing long-poll is not the oracle; the machine's own state is.
    await api().waitForState('app1', 'm1', 'started', 5);
  });
});
