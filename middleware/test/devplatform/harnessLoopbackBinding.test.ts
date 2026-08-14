/**
 * Regression guard for the intermittent 401/404 in the dev-platform route
 * tests.
 *
 * `app.listen(0)` binds the IPv6 wildcard `[::]`. On macOS/BSD that socket is
 * IPV6_V6ONLY, so the kernel reserves the port in the IPv6 ephemeral space
 * only — while every harness hands out `http://127.0.0.1:<port>`, an IPv4 URL.
 * The two spaces are independent, so an unrelated process holding the same
 * IPv4 port receives the request and answers it. The caller then observes that
 * foreign server's response: a 401 where it expected 404, a 404 where it
 * expected 201, or bytes undici cannot parse as HTTP at all.
 *
 * Binding 127.0.0.1 explicitly makes the reserved port and the dialled port
 * the same port, so the OS guarantees exclusivity.
 */

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import type { AddressInfo } from 'node:net';
import http from 'node:http';

import { makeHarness } from './devPlatformRoutes.harness.js';
import { makeHarness as makeRunnerHarness } from './devRunnerApi.harness.js';

describe('devPlatform test harnesses — loopback binding', () => {
  it('devPlatformRoutes harness binds the IPv4 loopback it advertises', async () => {
    const h = await makeHarness();
    try {
      const addr = h.server.address() as AddressInfo;
      assert.equal(addr.address, '127.0.0.1', 'must bind 127.0.0.1, not the IPv6 wildcard');
      assert.equal(addr.family, 'IPv4');
      assert.ok(h.baseUrl.startsWith(`http://127.0.0.1:${String(addr.port)}/`),
        'baseUrl must dial the address the server actually bound');
    } finally {
      await h.close();
    }
  });

  it('devRunnerApi harness binds the IPv4 loopback it advertises', async () => {
    const h = await makeRunnerHarness();
    try {
      const addr = h.server.address() as AddressInfo;
      assert.equal(addr.address, '127.0.0.1', 'must bind 127.0.0.1, not the IPv6 wildcard');
      assert.equal(addr.family, 'IPv4');
      assert.ok(h.baseUrl.startsWith(`http://127.0.0.1:${String(addr.port)}/`),
        'baseUrl must dial the address the server actually bound');
    } finally {
      await h.close();
    }
  });

  it('an IPv4-bound port cannot be shadowed by a second listener', async () => {
    // This is the property the fix buys: with the old `listen(0)` the same port
    // number stays free in the IPv4 space and a foreign process can serve the
    // harness's callers. Bound to 127.0.0.1, a colliding bind is refused.
    const h = await makeHarness();
    const { port } = h.server.address() as AddressInfo;
    const intruder = http.createServer((_req, res) => { res.writeHead(401); res.end(); });
    const code = await new Promise<string>((resolve) => {
      intruder.once('error', (err: NodeJS.ErrnoException) => resolve(err.code ?? 'none'));
      intruder.listen(port, '127.0.0.1', () => resolve('bound'));
    });
    if (code === 'bound') await new Promise<void>((r) => intruder.close(() => r()));
    await h.close();
    assert.equal(code, 'EADDRINUSE', 'the harness port must be exclusively held');
  });
});
