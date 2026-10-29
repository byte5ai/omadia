import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { Router } from 'express';
import type { RequestHandler } from 'express';

import { DefaultChannelRegistry } from '../src/channels/channelRegistry.js';
import { PluginRouteRegistry } from '../src/platform/pluginRouteRegistry.js';
import { PublicPathGrantRegistry } from '../src/platform/publicPathGrants.js';

// S3-G (#1596 follow-up) — a CHANNEL plugin's `permissions.public_paths` must be
// claimed on activation, like the tool runtime does. Before, only the tool
// runtime claimed: Teams' `/p/channel-teams` was declared, registered
// `auth:'custom'` and granted by the operator, yet the public-path mount never
// matched it and every Teams tab request answered 404. Drives the real
// `DefaultChannelRegistry.activate`/`deactivate`.

const TEAMS_ID = '@omadia/channel-teams';
const PREFIX = '/p/channel-teams';

function makeRegistry(granted: ReadonlySet<string>) {
  const noop = (): void => undefined;
  const unsub = (): (() => void) => () => undefined;
  const sessionGate: RequestHandler = (_req, res) => {
    res.status(401).end();
  };
  const routeRegistry = new PluginRouteRegistry({ sessionAuth: () => sessionGate });
  const grants = new PublicPathGrantRegistry();
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
    catalog: {
      get: () => entry,
      has: () => true,
      list: () => [entry],
      isBundledId: () => false,
    },
    installedRegistry: { list: () => [], get: () => entry },
    vault: { get: noop, set: noop, list: () => [] },
    serviceRegistry: { get: () => undefined, has: () => false, provide: unsub, replace: unsub },
    nativeToolRegistry: { register: noop, unregister: noop, list: () => [] },
    pluginRouteRegistry: routeRegistry,
    publicPathGrants: grants,
    publicPathGrantStore: { listForPlugin: () => Promise.resolve(granted) },
    corePublicPaths: [],
    notificationRouter: { registerChannel: unsub },
    uiRouteCatalog: { disposeBySource: noop },
    jobScheduler: { stopForPlugin: noop },
    pluginStatusRegistry: { clear: noop },
    resolver: {
      resolve: async () => ({
        activate: async (ctx: {
          routes: { register: (p: string, r: unknown, o?: unknown) => () => void };
        }) => {
          const dispose = ctx.routes.register(PREFIX, Router(), { auth: 'custom' });
          return {
            close: async () => {
              dispose();
            },
          };
        },
      }),
      invalidate: noop,
    },
    coreApi: { log: noop, registerRoute: noop, registerRouter: noop },
    routes: { setActive: noop, deactivateChannel: noop },
    webSockets: { setActive: noop, deactivateChannel: noop },
  };
  return { registry: new DefaultChannelRegistry(deps), grants };
}

describe('channel plugins claim their declared public paths (S3-G)', () => {
  it('a granted prefix resolves after activate and is released on deactivate', async () => {
    const { registry, grants } = makeRegistry(new Set([PREFIX]));
    assert.equal(grants.resolve(`${PREFIX}/hub`), null);
    await registry.activate(TEAMS_ID);
    assert.equal(grants.resolve(`${PREFIX}/hub`)?.pluginId, TEAMS_ID);
    await registry.deactivate(TEAMS_ID);
    assert.equal(grants.resolve(`${PREFIX}/hub`), null);
  });

  it('an ungranted prefix is claimed but not served', async () => {
    const { registry, grants } = makeRegistry(new Set());
    await registry.activate(TEAMS_ID);
    assert.equal(grants.resolve(`${PREFIX}/hub`), null);
    assert.ok(registry.isActive(TEAMS_ID));
  });
});
