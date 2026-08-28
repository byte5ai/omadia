import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { Router } from 'express';

import { ServiceRegistry } from '../src/platform/serviceRegistry.js';
import { newTestRouteRegistry } from './_helpers/routeRegistry.js';
import { UiRouteCatalog } from '../src/platform/uiRouteCatalog.js';
import { createPluginContext } from '../src/platform/pluginContext.js';
import type { CreatePluginContextOptions } from '../src/platform/pluginContext.js';
import {
  ToolPluginRuntime,
  type ToolPluginRuntimeDeps,
} from '../src/plugins/toolPluginRuntime.js';
import {
  DynamicAgentRuntime,
  type DynamicAgentRuntimeDeps,
} from '../src/plugins/dynamicAgentRuntime.js';

/**
 * Regression (B2): deactivating a plugin must take the services it provided
 * down with it.
 *
 * `ServiceRegistry` had no owner tracking and no `disposeBySource`, and
 * neither runtime called one on deactivate — so a provider whose `close()`
 * body forgets its dispose handle left the service registered against a
 * torn-down module. Consumers kept resolving the dead implementation, and
 * the reinstall threw `duplicate provider` because nothing had removed the
 * old entry.
 *
 * Same bug class as the Express-router leak in
 * `toolPluginRuntimeRouteDisposal.test.ts`, one layer down.
 */

function seedActive(runtime: ToolPluginRuntime, agentId: string): void {
  const active = (runtime as unknown as { active: Map<string, unknown> })
    .active;
  active.set(agentId, {
    agentId,
    handle: { close: (): Promise<void> => Promise.resolve() },
    extDisposes: [],
  });
}

describe('ServiceRegistry — owner tracking', () => {
  it('disposes only the services the named plugin provided', () => {
    const registry = new ServiceRegistry();
    registry.provide('kernelThing', { k: 1 });
    registry.provide('fromA', { a: 1 }, '@plugin/a');
    registry.provide('alsoFromA', { a: 2 }, '@plugin/a');
    registry.provide('fromB', { b: 1 }, '@plugin/b');

    assert.equal(registry.disposeBySource('@plugin/a'), 2);

    assert.equal(registry.has('fromA'), false);
    assert.equal(registry.has('alsoFromA'), false);
    assert.equal(registry.has('fromB'), true, "another plugin's service");
    assert.equal(registry.has('kernelThing'), true, "core's own registration");
  });

  it('is idempotent and reports 0 for an unknown or already-clean plugin', () => {
    const registry = new ServiceRegistry();
    registry.provide('svc', {}, '@plugin/a');

    assert.equal(registry.disposeBySource('@plugin/a'), 1);
    assert.equal(registry.disposeBySource('@plugin/a'), 0);
    assert.equal(registry.disposeBySource('@plugin/never-installed'), 0);
  });

  it('does not double-count a handle the plugin already released itself', () => {
    const registry = new ServiceRegistry();
    const dispose = registry.provide('svc', {}, '@plugin/a');

    dispose();

    assert.equal(registry.disposeBySource('@plugin/a'), 0);
    assert.equal(registry.has('svc'), false);
  });

  it('lets a re-provide succeed after disposal (the duplicate-provider bug)', () => {
    const registry = new ServiceRegistry();
    const v1 = { version: 1 };
    registry.provide('graph', v1, '@plugin/kg');

    assert.throws(
      () => registry.provide('graph', { version: 2 }, '@plugin/kg'),
      /duplicate provider/,
      'precondition: the registry rejects a second provider',
    );

    registry.disposeBySource('@plugin/kg');
    registry.provide('graph', { version: 2 }, '@plugin/kg');

    assert.deepEqual(registry.get('graph'), { version: 2 });
  });

  it('restores the shadowed provider when a replacing plugin goes away', () => {
    const registry = new ServiceRegistry();
    const base = { impl: 'base' };
    registry.provide('knowledgeGraph', base);
    registry.replace('knowledgeGraph', { impl: 'wrapper' }, '@plugin/extras');

    assert.equal(registry.disposeBySource('@plugin/extras'), 1);
    assert.equal(
      registry.get('knowledgeGraph'),
      base,
      'the underlying provider stays live for the rest of the system',
    );
  });

  it('unwinds a plugin\'s stacked registrations newest-first', () => {
    // A `replace` restores whatever was live when it ran. Unwinding oldest
    // first would reinstate a provider the newer replace has since shadowed.
    const registry = new ServiceRegistry();
    const base = { impl: 'base' };
    registry.provide('svc', base);
    registry.replace('svc', { impl: 'inner' }, '@plugin/a');
    registry.replace('svc', { impl: 'outer' }, '@plugin/a');

    assert.equal(registry.disposeBySource('@plugin/a'), 2);
    assert.equal(registry.get('svc'), base);
  });
});

describe('PluginContext — service ownership comes from the kernel', () => {
  it('attributes ctx.services.provide to the context\'s own agentId', () => {
    const registry = new ServiceRegistry();
    const stub = (): (() => void) => (): void => {};
    const ctx = createPluginContext({
      agentId: '@plugin/provider',
      vault: {
        get: async (): Promise<undefined> => undefined,
        listKeys: async (): Promise<string[]> => [],
      },
      registry: { has: () => true, list: () => [], get: () => undefined },
      catalog: { list: () => [], get: () => undefined },
      serviceRegistry: registry,
      nativeToolRegistry: { register: stub, registerHandler: stub },
      routeRegistry: { register: stub, disposeBySource: () => 0 },
      jobScheduler: { register: stub, stopForPlugin: (): void => {} },
      logger: (): void => {},
    } as unknown as CreatePluginContextOptions);

    ctx.services.provide('someService', { ok: true });

    assert.equal(registry.has('someService'), true);
    assert.equal(registry.disposeBySource('@plugin/provider'), 1);
    assert.equal(registry.has('someService'), false);
  });
});

describe('ToolPluginRuntime.deactivate — service disposal', () => {
  function makeRuntime(serviceRegistry: ServiceRegistry): ToolPluginRuntime {
    const deps = {
      pluginRouteRegistry: newTestRouteRegistry(),
      uiRouteCatalog: new UiRouteCatalog(),
      serviceRegistry,
      jobScheduler: { stopForPlugin: (): void => {} },
      log: (): void => {},
    } as unknown as ToolPluginRuntimeDeps;
    return new ToolPluginRuntime(deps);
  }

  it('unregisters the services provided by the deactivated plugin', async () => {
    const serviceRegistry = new ServiceRegistry();
    const runtime = makeRuntime(serviceRegistry);

    // The leak: the plugin's close() never calls this handle.
    serviceRegistry.provide('examplePlugin', { impl: 1 }, '@plugin/dev');
    seedActive(runtime, '@plugin/dev');

    assert.equal(serviceRegistry.has('examplePlugin'), true, 'precondition');

    await runtime.deactivate('@plugin/dev');

    assert.equal(serviceRegistry.has('examplePlugin'), false);
  });

  it('leaves another plugin\'s services and core\'s own registrations alone', async () => {
    const serviceRegistry = new ServiceRegistry();
    const runtime = makeRuntime(serviceRegistry);

    serviceRegistry.provide('anthropicClient', { core: true });
    serviceRegistry.provide('fromA', {}, '@plugin/a');
    serviceRegistry.provide('fromB', {}, '@plugin/b');
    seedActive(runtime, '@plugin/a');

    await runtime.deactivate('@plugin/a');

    assert.equal(serviceRegistry.has('fromA'), false);
    assert.equal(serviceRegistry.has('fromB'), true);
    assert.equal(serviceRegistry.has('anthropicClient'), true);
  });

  it('disposes services BEFORE awaiting the plugin-controlled close()', async () => {
    // close() gets a 5s budget. Disposing after it would leave a service
    // resolvable for that whole window on a deactivation the operator has
    // already triggered — and for the full 5s when close() hangs. Same
    // reasoning as the route disposal.
    const serviceRegistry = new ServiceRegistry();
    const runtime = makeRuntime(serviceRegistry);
    serviceRegistry.provide('examplePlugin', { impl: 1 }, '@plugin/slow');

    let stillRegisteredWhenCloseRan: boolean | undefined;
    (runtime as unknown as { active: Map<string, unknown> }).active.set(
      '@plugin/slow',
      {
        agentId: '@plugin/slow',
        extDisposes: [],
        handle: {
          close: (): Promise<void> => {
            stillRegisteredWhenCloseRan =
              serviceRegistry.has('examplePlugin');
            return Promise.resolve();
          },
        },
      },
    );

    await runtime.deactivate('@plugin/slow');

    assert.equal(
      stillRegisteredWhenCloseRan,
      false,
      'the service must already be gone by the time close() runs',
    );
  });

  it('unregisters services when activate() throws after providing one', async () => {
    // A plugin that provided a service and THEN threw never reaches
    // active.set, so deactivate() is a no-op — without the rollback every
    // retry would fail with 'duplicate provider' instead of the real error.
    const serviceRegistry = new ServiceRegistry();
    const runtime = makeRuntime(serviceRegistry);
    serviceRegistry.provide('halfBuilt', {}, '@plugin/broken');

    assert.equal(await runtime.deactivate('@plugin/broken'), false);
    assert.equal(
      serviceRegistry.has('halfBuilt'),
      true,
      'deactivate cannot clean up what never activated — hence the rollback in activate()',
    );
  });
});

describe('DynamicAgentRuntime.deactivate — service disposal', () => {
  it('unregisters the services the agent provided, not just the kernel\'s subAgent entry', async () => {
    const serviceRegistry = new ServiceRegistry();
    const deps = {
      serviceRegistry,
      pluginRouteRegistry: newTestRouteRegistry(),
      uiRouteCatalog: new UiRouteCatalog(),
      jobScheduler: { stopForPlugin: (): void => {} },
      log: (): void => {},
    } as unknown as DynamicAgentRuntimeDeps;
    const runtime = new DynamicAgentRuntime(deps);

    const disposeSubAgentService = serviceRegistry.provide(
      'subAgent:@agent/x',
      { tool: true },
    );
    serviceRegistry.provide('agentOwned', { impl: 1 }, '@agent/x');

    (runtime as unknown as { active: Map<string, unknown> }).active.set(
      '@agent/x',
      {
        agentId: '@agent/x',
        handle: { close: (): Promise<void> => Promise.resolve() },
        domainTool: { name: 'x_domain' },
        rawTools: [],
        subAgentTools: [],
        disposeSubAgentService,
      },
    );

    await runtime.deactivate('@agent/x');

    assert.equal(serviceRegistry.has('subAgent:@agent/x'), false);
    assert.equal(serviceRegistry.has('agentOwned'), false);
  });
});

describe('PluginRouteRegistry — unchanged behaviour alongside the new call', () => {
  it('still disposes routers by source', async () => {
    const routes = newTestRouteRegistry();
    const serviceRegistry = new ServiceRegistry();
    const deps = {
      pluginRouteRegistry: routes,
      uiRouteCatalog: new UiRouteCatalog(),
      serviceRegistry,
      jobScheduler: { stopForPlugin: (): void => {} },
      log: (): void => {},
    } as unknown as ToolPluginRuntimeDeps;
    const runtime = new ToolPluginRuntime(deps);

    routes.register('/api/v1/example-plugin', Router(), '@plugin/dev');
    seedActive(runtime, '@plugin/dev');

    await runtime.deactivate('@plugin/dev');

    assert.equal(routes.list().every((e) => e.disposed), true);
  });
});
