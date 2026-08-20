import { strict as assert } from 'node:assert';
import { describe, it, after, before } from 'node:test';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

import { createPublishGateway, type PublishGatewayTarget } from '../../packages/harness-publish/src/publishGateway.js';

/**
 * Issue #581 — the non-negotiable proof: a published app can neither READ
 * an admin session cookie forwarded through the gateway, nor SET a cookie
 * scoped to the admin's own host. Both fake "admin" and "app backend" here
 * are plain `http.Server`s — no Docker, no real browser, just the actual
 * HTTP semantics the gateway is responsible for. `appsHostSuffix` models a
 * dedicated apps domain (e.g. `.apps.omadia.internal`); the admin's own
 * host (`admin.omadia.internal`) never ends with it.
 *
 * Uses `http.request` directly rather than the `fetch` global: the Fetch
 * spec forbids a caller from overriding the `Host` header, which is exactly
 * what these tests need to control to simulate different virtual hosts
 * hitting one gateway port.
 */
const APPS_HOST_SUFFIX = '.apps.omadia.internal';
const ADMIN_HOST = 'admin.omadia.internal';

async function listen(server: http.Server): Promise<{ port: number; close: () => Promise<void> }> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return { port, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

interface RawResponse {
  readonly status: number;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: string;
}

function request(port: number, host: string, extraHeaders: Record<string, string> = {}): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/', method: 'GET', headers: { host, ...extraHeaders } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('PublishGateway — origin isolation from the admin/portal origin', () => {
  let appBackend: http.Server;
  let appPort: number;
  let closeAppBackend: () => Promise<void>;
  let receivedCookieHeader: string | undefined;
  let appReceivedRequests = 0;
  let appSetCookieToSend: string | undefined;

  let gateway: http.Server;
  let gatewayPort: number;
  let gatewayResolveCalls: string[] = [];

  before(async () => {
    appBackend = http.createServer((req, res) => {
      appReceivedRequests += 1;
      receivedCookieHeader = req.headers.cookie;
      if (appSetCookieToSend) res.setHeader('set-cookie', appSetCookieToSend);
      res.end('app-response');
    });
    const listening = await listen(appBackend);
    appPort = listening.port;
    closeAppBackend = listening.close;

    const resolveTarget = async (appSlug: string): Promise<PublishGatewayTarget | undefined> => {
      gatewayResolveCalls.push(appSlug);
      if (appSlug === 'todo') return { host: '127.0.0.1', port: appPort };
      return undefined;
    };
    gateway = createPublishGateway({ appsHostSuffix: APPS_HOST_SUFFIX, resolveTarget });
    const gatewayListening = await listen(gateway);
    gatewayPort = gatewayListening.port;
  });

  after(async () => {
    await closeAppBackend();
    await new Promise<void>((resolve) => gateway.close(() => resolve()));
  });

  it('rejects a request whose Host is the admin origin — the app backend is never even resolved', async () => {
    appReceivedRequests = 0;
    gatewayResolveCalls = [];
    const res = await request(gatewayPort, ADMIN_HOST);
    assert.equal(res.status, 400);
    assert.equal(appReceivedRequests, 0, 'the app backend must never see a request addressed to the admin host');
    assert.deepEqual(gatewayResolveCalls, [], 'resolveTarget must not even be consulted for a non-apps host');
  });

  it('strips the Cookie header before forwarding to the app backend, even when it carries an admin session cookie', async () => {
    receivedCookieHeader = 'not-set-yet';
    const res = await request(gatewayPort, `todo${APPS_HOST_SUFFIX}`, { cookie: 'admin_session=super-secret-token' });
    assert.equal(res.status, 200);
    assert.equal(receivedCookieHeader, undefined, 'the app backend must receive NO Cookie header at all');
  });

  it('strips a Set-Cookie the app tries to scope to an explicit Domain=', async () => {
    appSetCookieToSend = 'hijack=1; Domain=admin.omadia.internal; Path=/';
    const res = await request(gatewayPort, `todo${APPS_HOST_SUFFIX}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers['set-cookie'], undefined, 'a domain-scoped Set-Cookie from the app must never reach the client');
    appSetCookieToSend = undefined;
  });

  it('passes through an app-scoped Set-Cookie (no explicit Domain=) unchanged', async () => {
    appSetCookieToSend = 'app_session=fine; Path=/';
    const res = await request(gatewayPort, `todo${APPS_HOST_SUFFIX}`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.headers['set-cookie'], ['app_session=fine; Path=/']);
    appSetCookieToSend = undefined;
  });

  it('proxies a normal request/response through correctly (functional correctness, not just security)', async () => {
    const res = await request(gatewayPort, `todo${APPS_HOST_SUFFIX}`);
    assert.equal(res.body, 'app-response');
  });

  it('returns 404 when resolveTarget has no live version for the app', async () => {
    const res = await request(gatewayPort, `nope${APPS_HOST_SUFFIX}`);
    assert.equal(res.status, 404);
  });
});
