import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { once } from 'node:events';
import http from 'node:http';
import express, { Router } from 'express';
import type { AddressInfo } from 'node:net';

import { PluginRouteRegistry } from '../../src/platform/pluginRouteRegistry.js';

interface BootedApp {
  url: string;
  close: () => Promise<void>;
}

async function bootApp(app: express.Express): Promise<BootedApp> {
  const server = http.createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    close: async () => {
      server.close();
      await once(server, 'close');
    },
  };
}

async function getStatus(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      // Drain so the socket can close.
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
  });
}

function makeRouter(body: string): Router {
  const r = Router();
  r.get('/ping', (_req, res) => {
    res.status(200).type('text/plain').send(body);
  });
  return r;
}

describe('PluginRouteRegistry', () => {
  it('mounts boot-time registered routers on the app', async () => {
    const reg = new PluginRouteRegistry();
    reg.register('/api/foo', makeRouter('foo-pong'), 'foo-plugin');
    const app = express();
    reg.mountAll(app);
    const booted = await bootApp(app);
    try {
      assert.equal(await getStatus(`${booted.url}/api/foo/ping`), 200);
    } finally {
      await booted.close();
    }
  });

  it('lists every registered entry for diagnostics', () => {
    const reg = new PluginRouteRegistry();
    reg.register('/api/a', makeRouter('a'), 'a-plugin');
    reg.register('/api/b', makeRouter('b'), 'b-plugin');
    const list = reg.list();
    assert.equal(list.length, 2);
    assert.equal(list[0]?.prefix, '/api/a');
    assert.equal(list[0]?.source, 'a-plugin');
    assert.equal(list[0]?.disposed, false);
  });

  it('lets dispose() neuter a boot-mounted router (404 pass-through)', async () => {
    const reg = new PluginRouteRegistry();
    const dispose = reg.register('/api/foo', makeRouter('foo-pong'), 'foo-plugin');
    const app = express();
    reg.mountAll(app);
    const booted = await bootApp(app);
    try {
      assert.equal(await getStatus(`${booted.url}/api/foo/ping`), 200);
      dispose();
      // After dispose, the registry passes through to express's default
      // 404 — the router is no longer reachable.
      assert.equal(await getStatus(`${booted.url}/api/foo/ping`), 404);
    } finally {
      await booted.close();
    }
  });

  it('hot-mounts a router registered AFTER mountAll has run', async () => {
    // Regression: pre-fix, register() after boot pushed to entries[] but
    // never reached Express, so hot-installed plugins (e.g. unifi-device-
    // tracker v0.2.0 admin UI) returned 404 on every request despite the
    // plugin's activate() having logged the mount as successful.
    const reg = new PluginRouteRegistry();
    const app = express();
    reg.mountAll(app); // boot flush — registry has zero entries
    const booted = await bootApp(app);
    try {
      assert.equal(
        await getStatus(`${booted.url}/api/late/ping`),
        404,
        'route does not exist before register',
      );
      reg.register('/api/late', makeRouter('late-pong'), 'late-plugin');
      assert.equal(
        await getStatus(`${booted.url}/api/late/ping`),
        200,
        'route is reachable IMMEDIATELY after a post-boot register',
      );
    } finally {
      await booted.close();
    }
  });

  it('rejects a non-Express router with a clear error', () => {
    const reg = new PluginRouteRegistry();
    assert.throws(
      () => reg.register('/api/bad', { not: 'a router' }, 'bad-plugin'),
      /non-Express router/,
    );
  });

  it('rejects a prefix that does not start with `/`', () => {
    const reg = new PluginRouteRegistry();
    assert.throws(
      () => reg.register('api/missing-slash', makeRouter('x'), 'src'),
      /must start with/,
    );
  });

  it('disposeBySource flips every still-active entry with the given source', () => {
    const reg = new PluginRouteRegistry();
    reg.register('/api/a', makeRouter('a'), 'agent-X');
    reg.register('/api/b', makeRouter('b'), 'agent-X');
    const disposed = reg.disposeBySource('agent-X');
    assert.equal(disposed, 2);
    assert.ok(reg.list().every((e) => e.disposed));
  });

  it('disposeBySource leaves entries with other sources alone', () => {
    const reg = new PluginRouteRegistry();
    reg.register('/api/a', makeRouter('a'), 'agent-X');
    reg.register('/api/b', makeRouter('b'), 'agent-Y');
    const disposed = reg.disposeBySource('agent-X');
    assert.equal(disposed, 1);
    const list = reg.list();
    assert.equal(list.find((e) => e.source === 'agent-X')?.disposed, true);
    assert.equal(list.find((e) => e.source === 'agent-Y')?.disposed, false);
  });

  it('disposeBySource is idempotent — second call returns 0', () => {
    const reg = new PluginRouteRegistry();
    reg.register('/api/a', makeRouter('a'), 'agent-X');
    assert.equal(reg.disposeBySource('agent-X'), 1);
    assert.equal(reg.disposeBySource('agent-X'), 0);
  });
});
