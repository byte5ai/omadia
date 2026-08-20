import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import express, { Router } from 'express';

import { getJson } from './_helpers/httpInvoke.js';

import type { PluginRouteRegistry } from '../src/platform/pluginRouteRegistry.js';
import { newTestRouteRegistry } from './_helpers/routeRegistry.js';
import { ServiceRegistry } from '../src/platform/serviceRegistry.js';
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
    // Service disposal is the sibling of route disposal on the same
    // deactivate path — see serviceRegistryDisposal.test.ts for its coverage.
    serviceRegistry: new ServiceRegistry(),
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
    const registry = newTestRouteRegistry();
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
    const registry = newTestRouteRegistry();
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
    const registry = newTestRouteRegistry();
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

  it('disposes routes BEFORE awaiting the plugin-controlled close()', async () => {
    // close() gets a 5s budget. Disposing after it would leave the router
    // answering for that whole window on a deactivation the operator has
    // already triggered — and for the full 5s when close() hangs.
    const registry = newTestRouteRegistry();
    const catalog = new UiRouteCatalog();
    const deps = {
      pluginRouteRegistry: registry,
      uiRouteCatalog: catalog,
      serviceRegistry: new ServiceRegistry(),
      jobScheduler: { stopForPlugin: (): void => {} },
      log: (): void => {},
    } as unknown as ToolPluginRuntimeDeps;
    const runtime = new ToolPluginRuntime(deps);

    registry.register('/api/v1/dev-runner', Router(), '@plugin/slow');

    let disposedWhenCloseRan: boolean | undefined;
    (runtime as unknown as { active: Map<string, unknown> }).active.set(
      '@plugin/slow',
      {
        agentId: '@plugin/slow',
        extDisposes: [],
        handle: {
          close: (): Promise<void> => {
            disposedWhenCloseRan =
              registry.list().every((e) => e.disposed) && catalog.navSize() === 0;
            return Promise.resolve();
          },
        },
      },
    );

    await runtime.deactivate('@plugin/slow');

    assert.equal(
      disposedWhenCloseRan,
      true,
      'routes and nav must already be disposed by the time close() runs',
    );
  });

  it('deactivate() cannot clean up a plugin that never became active', async () => {
    // Documents WHY activate() must roll back its own registrations: a
    // plugin that registers a router and then throws never reaches
    // active.set, so this path is a no-op and the orphan would otherwise
    // serve for the life of the process. The rollback itself lives in
    // activate()'s catch and is NOT covered here — driving it needs a real
    // on-disk package plus catalog/vault wiring. Tracked as a test gap in
    // specs/470-dev-platform-plugin/plan.md.
    const registry = newTestRouteRegistry();
    const { runtime } = makeRuntime(registry, new UiRouteCatalog());
    registry.register('/api/v1/half-built', Router(), '@plugin/broken');

    assert.equal(await runtime.deactivate('@plugin/broken'), false);
    assert.equal(
      registry.list().some((e) => e.source === '@plugin/broken' && !e.disposed),
      true,
      'the orphaned router survives deactivate() — hence the rollback in activate()',
    );
  });

  it('a disposed router stops answering and falls through to the next handler', async () => {
    const registry = newTestRouteRegistry();
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

    const live = await getJson<{ from: string }>(app, '/api/v1/dev-runner/ping');
    assert.equal(live.status, 200);
    assert.deepEqual(live.body, { from: 'plugin' });

    await runtime.deactivate('@plugin/dev');

    const dead = await getJson<{ from: string }>(app, '/api/v1/dev-runner/ping');
    assert.equal(
      dead.status,
      404,
      'an uninstalled plugin must not keep serving its routes',
    );
    assert.deepEqual(dead.body, { from: 'fallthrough' });
  });
});
