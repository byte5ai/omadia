import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import express, { Router } from 'express';
import type { AddressInfo } from 'node:net';

import { publicPaths } from '../src/auth/publicPaths.js';
import { DefaultChannelRegistry } from '../src/channels/channelRegistry.js';
import { PluginRouteRegistry } from '../src/platform/pluginRouteRegistry.js';
import { PublicPathGrantRegistry } from '../src/platform/publicPathGrants.js';
import { createPublicPathMount } from '../src/platform/publicPathMount.js';
import { listenLoopback } from './_helpers/listenLoopback.js';

/**
 * #1596 follow-up — a CHANNEL plugin's granted `auth: 'custom'` route is
 * served. Only the tool runtime used to claim declared public paths, so
 * channel-teams' Teams-tab pages (`/p/channel-teams/hub`) answered 404 once
 * #1596 removed the static `/p/` exemption that had been hiding it.
 */

const TEAMS_ID = '@omadia/channel-teams';
const PREFIX = '/p/channel-teams';

function makeRegistry(opts: {
  routes: PluginRouteRegistry;
  grants: PublicPathGrantRegistry;
  granted: readonly string[];
}): DefaultChannelRegistry {
  const noop = (): void => undefined;
  const unsub = (): (() => void) => () => undefined;
  const entry = {
    plugin: {
      id: TEAMS_ID,
      kind: 'channel',
      domain: 'channel.teams',
      depends_on: [],
      permissions_summary: { public_paths: [PREFIX] },
      setup_fields: [],
      integrations_summary: [],
      provides: [],
      requires: [],
      jobs: [],
    },
    manifest: { schema_version: '1', identity: { id: TEAMS_ID, kind: 'channel' } },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const deps: any = {
    catalog: { get: () => entry, has: () => true, list: () => [entry], isBundledId: () => false },
    installedRegistry: { list: () => [], get: () => entry },
    vault: { get: noop, set: noop, list: () => [] },
    serviceRegistry: { get: () => undefined, has: () => false, provide: unsub, replace: unsub },
    nativeToolRegistry: { register: noop, unregister: noop, list: () => [] },
    pluginRouteRegistry: opts.routes,
    publicPathGrants: opts.grants,
    publicPathGrantStore: { listForPlugin: async () => new Set(opts.granted) },
    corePublicPaths: publicPaths(),
    notificationRouter: { registerChannel: unsub },
    uiRouteCatalog: { disposeBySource: noop },
    jobScheduler: { stopForPlugin: noop },
    pluginStatusRegistry: { clear: noop },
    resolver: {
      resolve: async () => ({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        activate: async (ctx: any) => {
          const r = Router();
          r.get('/hub', (_req, res) => {
            res.status(200).send('hub shell');
          });
          const dispose = ctx.routes.register(PREFIX, r, { auth: 'custom' });
          return { close: async () => dispose() };
        },
      }),
      invalidate: noop,
    },
    coreApi: { log: noop, registerRoute: noop, registerRouter: noop },
    routes: { setActive: noop, deactivateChannel: noop },
    webSockets: { setActive: noop, deactivateChannel: noop },
  };
  return new DefaultChannelRegistry(deps);
}

async function serve(routes: PluginRouteRegistry, grants: PublicPathGrantRegistry) {
  const app = express();
  app.use(createPublicPathMount({ grants, routes, logger: () => undefined }));
  routes.mountAll(app);
  app.use((_req, res) => {
    res.status(404).json({ code: 'not_found' });
  });
  const server = await listenLoopback(app);
  const { port } = server.address() as AddressInfo;
  return { server, base: `http://127.0.0.1:${String(port)}` };
}

describe('#1596 follow-up — channel plugins claim their declared public paths', () => {
  it('a granted auth:custom channel route is served without a session', async () => {
    const routes = new PluginRouteRegistry({ sessionAuth: () => (_q, _s, n) => n() });
    const grants = new PublicPathGrantRegistry();
    await makeRegistry({ routes, grants, granted: [PREFIX] }).activate(TEAMS_ID);
    const { server, base } = await serve(routes, grants);
    try {
      const res = await fetch(`${base}${PREFIX}/hub`);
      assert.equal(res.status, 200);
      assert.equal(await res.text(), 'hub shell');
    } finally {
      server.close();
    }
  });

  it('without the operator grant it is not served', async () => {
    const routes = new PluginRouteRegistry({ sessionAuth: () => (_q, _s, n) => n() });
    const grants = new PublicPathGrantRegistry();
    await makeRegistry({ routes, grants, granted: [] }).activate(TEAMS_ID);
    const { server, base } = await serve(routes, grants);
    try {
      assert.notEqual((await fetch(`${base}${PREFIX}/hub`)).status, 200);
    } finally {
      server.close();
    }
  });

  it('deactivate releases the claim', async () => {
    const routes = new PluginRouteRegistry({ sessionAuth: () => (_q, _s, n) => n() });
    const grants = new PublicPathGrantRegistry();
    const reg = makeRegistry({ routes, grants, granted: [PREFIX] });
    await reg.activate(TEAMS_ID);
    assert.notEqual(grants.resolve(`${PREFIX}/hub`), null, 'the granted claim holds');
    const { server, base } = await serve(routes, grants);
    try {
      assert.equal((await fetch(`${base}${PREFIX}/hub`)).status, 200, 'served while active');
      await reg.deactivate(TEAMS_ID);
      assert.equal(grants.releaseBySource(TEAMS_ID), 0, 'deactivate already released the claim');
      assert.notEqual((await fetch(`${base}${PREFIX}/hub`)).status, 200, 'not served after deactivate');
    } finally {
      server.close();
    }
  });
});
