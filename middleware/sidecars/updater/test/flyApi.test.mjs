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
