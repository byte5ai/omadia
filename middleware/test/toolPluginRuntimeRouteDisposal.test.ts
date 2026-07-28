import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import type { AddressInfo } from 'node:net';
import express, { Router } from 'express';

import { PluginRouteRegistry } from '../src/platform/pluginRouteRegistry.js';
import { UiRouteCatalog } from '../src/platform/uiRouteCatalog.js';
import {
  ToolPluginRuntime,
  type ToolPluginRuntimeDeps,
} from '../src/plugins/toolPluginRuntime.js';

/**
 * Regression: deactivating a tool plugin must take its Express routers
 * down with it.
 *
 * Express cannot unmount, so `PluginRouteRegistry` flips entries to
 * `disposed` and the mounted closure falls through to `next()`.
 * `DynamicAgentRuntime` calls `disposeBySource` on deactivate;
 * `ToolPluginRuntime` held the same dependency and threaded it into every
 * plugin context, but never disposed by source — so an uninstalled tool
 * plugin kept serving its routes, and because Express matches
 * first-mount-wins it also shadowed anything mounted later at the same
 * prefix after a hot-upgrade.
 *
 * This matters for the dev-platform extraction
 * (specs/470-dev-platform-plugin): "with the plugin not installed, no
 * dev-platform code paths" is not verifiable while routers outlive their
 * plugin.
 */

/**
 * `deactivate()` only reaches a handful of dependencies. Everything else on
 * `ToolPluginRuntimeDeps` is activate-path machinery, so it is left unset
 * rather than stubbed into something that could drift from the real thing.
 */
function makeRuntime(
  pluginRouteRegistry: PluginRouteRegistry,
  uiRouteCatalog: UiRouteCatalog,
): { runtime: ToolPluginRuntime; stoppedJobsFor: string[] } {
  const stoppedJobsFor: string[] = [];
  const deps = {
    pluginRouteRegistry,
    uiRouteCatalog,
    jobScheduler: {
      stopForPlugin: (id: string): void => {
        stoppedJobsFor.push(id);
      },
    },
    log: (): void => {},
  } as unknown as ToolPluginRuntimeDeps;
  return { runtime: new ToolPluginRuntime(deps), stoppedJobsFor };
}

/**
 * Seed an active entry directly. `activate()` would need a catalog, an
 * installed registry, a vault and a real on-disk package to dynamic-import;
 * none of that is what this test is about. TypeScript's `private` is
 * compile-time only, so the real `deactivate()` body runs unmodified.
 */
function seedActive(runtime: ToolPluginRuntime, agentId: string): void {
  const active = (
    runtime as unknown as {
      active: Map<string, unknown>;
    }
  ).active;
  active.set(agentId, {
    agentId,
    handle: { close: (): Promise<void> => Promise.resolve() },
    extDisposes: [],
  });
}

describe('ToolPluginRuntime.deactivate — route disposal', () => {
  it('disposes the plugin routers registered by the deactivated plugin', async () => {
    const registry = new PluginRouteRegistry();
    const { runtime } = makeRuntime(registry, new UiRouteCatalog());

    registry.register('/api/v1/dev-runner', Router(), '@plugin/dev');
    seedActive(runtime, '@plugin/dev');

    assert.equal(
      registry.list().filter((e) => !e.disposed).length,
      1,
      'precondition: the router is live',
    );

    await runtime.deactivate('@plugin/dev');

    assert.deepEqual(
      registry.list().map((e) => ({ source: e.source, disposed: e.disposed })),
      [{ source: '@plugin/dev', disposed: true }],
    );
  });

  it('leaves another plugin\'s routers untouched', async () => {
    const registry = new PluginRouteRegistry();
    const { runtime } = makeRuntime(registry, new UiRouteCatalog());

    registry.register('/a', Router(), '@plugin/a');
    registry.register('/b', Router(), '@plugin/b');
    seedActive(runtime, '@plugin/a');

    await runtime.deactivate('@plugin/a');

    const bySource = Object.fromEntries(
      registry.list().map((e) => [e.source, e.disposed]),
    );
    assert.equal(bySource['@plugin/a'], true);
    assert.equal(bySource['@plugin/b'], false);
  });

  it('also disposes ui-route/nav entries and stops jobs (unchanged behaviour)', async () => {
    const registry = new PluginRouteRegistry();
    const catalog = new UiRouteCatalog();
    const { runtime, stoppedJobsFor } = makeRuntime(registry, catalog);

    catalog.registerNav('@plugin/dev', {
      navId: 'devPlatform',
      href: '/admin/dev-platform',
      label: { en: 'Dev Platform' },
    });
    seedActive(runtime, '@plugin/dev');

    await runtime.deactivate('@plugin/dev');

    assert.equal(catalog.navSize(), 0, 'menu entry goes away with the plugin');
    assert.deepEqual(stoppedJobsFor, ['@plugin/dev']);
  });

  it('a disposed router stops answering and falls through to the next handler', async () => {
    const registry = new PluginRouteRegistry();
    const { runtime } = makeRuntime(registry, new UiRouteCatalog());

    const pluginRouter = Router();
    pluginRouter.get('/ping', (_req, res) => {
      res.status(200).json({ from: 'plugin' });
    });
    registry.register('/api/v1/dev-runner', pluginRouter, '@plugin/dev');
    seedActive(runtime, '@plugin/dev');

    const app = express();
    registry.mountAll(app);
    // Whatever would have handled the prefix had the plugin never existed.
    app.use((_req, res) => {
      res.status(404).json({ from: 'fallthrough' });
    });

    const server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;

    try {
      const live = await fetch(`${base}/api/v1/dev-runner/ping`);
      assert.equal(live.status, 200);
      assert.deepEqual(await live.json(), { from: 'plugin' });

      await runtime.deactivate('@plugin/dev');

      const dead = await fetch(`${base}/api/v1/dev-runner/ping`);
      assert.equal(
        dead.status,
        404,
        'an uninstalled plugin must not keep serving its routes',
      );
      assert.deepEqual(await dead.json(), { from: 'fallthrough' });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
