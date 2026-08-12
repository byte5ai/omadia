/**
 * The connect-time SSRF boundary for MCP's OAuth/discovery traffic.
 *
 * `assertPublicHttpsUrl` cannot be this boundary: it resolves the hostname, and
 * then a SEPARATE `fetch` resolves it again. Two lookups, two answers — a
 * rebinding host returns a public address to the guard and a private one to the
 * fetch. It also swallows lookup errors by design. So the real enforcement has
 * to happen at the socket, which is what `guardedOutboundFetch` delegates to
 * `createGuardedAgent()`.
 *
 * These cases deliberately bypass `assertPublicHttpsUrl` and hit
 * `guardedOutboundFetch` directly. Going through a caller would prove nothing:
 * the pre-check rejects `localhost` on the hostname alone, so the test would
 * pass with the dispatcher removed.
 *
 * Hermetic — the only server involved is the loopback one started here.
 */

import { describe, it, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { guardedOutboundFetch } from '../src/services/guardedOutboundFetch.js';

const servers: Server[] = [];

after(() => {
  for (const s of servers) s.close();
});

async function loopbackServer(): Promise<number> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"reached":true}');
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

describe('guardedOutboundFetch', () => {
  it('refuses a host that resolves to loopback', async () => {
    const port = await loopbackServer();
    // `localhost` resolves through the real system resolver to 127.0.0.1, so
    // this exercises the dispatcher's own lookup rather than a literal-IP
    // shortcut — the same code path a rebinding hostname would take.
    await assert.rejects(
      () => guardedOutboundFetch(`http://localhost:${String(port)}/`),
      'a name resolving to 127.0.0.1 must be refused at connect, not fetched',
    );
  });

  it('refuses a literal private address', async () => {
    const port = await loopbackServer();
    await assert.rejects(() => guardedOutboundFetch(`http://127.0.0.1:${String(port)}/`));
  });

  it('fails CLOSED when the name does not resolve', async () => {
    // The old pre-check treated NXDOMAIN as "not my problem — the fetch will
    // fail anyway", which is exactly the gap a split-horizon resolver walks
    // through. The dispatcher must surface it as a failure instead.
    await assert.rejects(() =>
      guardedOutboundFetch('http://this-name-does-not-resolve.invalid/'),
    );
  });

  it('still reaches a server addressed by a public-looking literal', async () => {
    // Guard rails only: proves the dispatcher is not refusing everything, which
    // is the failure mode that would make the three cases above vacuous.
    // 203.0.113.0/24 is TEST-NET-3 and is classified public, so the connection
    // is ATTEMPTED and fails on transport rather than on the SSRF check.
    await assert.rejects(
      () => guardedOutboundFetch('http://203.0.113.1:9/'),
      (err: unknown) =>
        err instanceof Error && !/non-public address/.test(String(err.cause ?? err)),
      'TEST-NET-3 must fail on connect, not be rejected as non-public',
    );
  });
});
