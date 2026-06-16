/**
 * Spec 004 — `ctx.status` accessor + PluginStatusRegistry.
 *
 * The accessor is always present, ungated, self-scoped to the plugin id, and
 * normalizes malformed input. `report({state:'ok'})` and `clear()` both leave
 * no entry (the UI badges only needs_action / error).
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { Plugin } from '../src/api/admin-v1.js';
import type {
  PluginCatalog,
  PluginCatalogEntry,
} from '../src/plugins/manifestLoader.js';
import { ServiceRegistry } from '../src/platform/serviceRegistry.js';
import { PluginStatusRegistry } from '../src/platform/pluginStatusRegistry.js';
import { createPluginContext } from '../src/platform/pluginContext.js';

function makeCatalog(id: string): PluginCatalog {
  const plugin = {
    id,
    kind: 'integration',
    name: id,
    version: '0.1.0',
    domain: 'test',
    setup_fields: [],
    permissions_summary: {
      memory_reads: [],
      memory_writes: [],
      graph_reads: [],
      graph_writes: [],
      network_outbound: [],
    },
    depends_on: [],
    provides: [],
    requires: [],
  } as unknown as Plugin;
  const entry = {
    plugin,
    manifest: {},
    source_path: `/abs/${id}/manifest.yaml`,
    source_kind: 'manifest-v1',
  } as unknown as PluginCatalogEntry;
  return {
    list: () => [entry],
    get: (q: string) => (q === id ? entry : undefined),
  } as unknown as PluginCatalog;
}

function makeCtx(id: string, statusRegistry?: PluginStatusRegistry) {
  const stub = () => () => {};
  return createPluginContext({
    agentId: id,
    vault: {
      get: async () => undefined,
      listKeys: async () => [],
    } as unknown as Parameters<typeof createPluginContext>[0]['vault'],
    registry: {
      has: () => true,
      list: () => [],
      get: () => undefined,
    } as unknown as Parameters<typeof createPluginContext>[0]['registry'],
    catalog: makeCatalog(id),
    serviceRegistry: new ServiceRegistry(),
    nativeToolRegistry: {
      register: stub,
      registerHandler: stub,
    } as unknown as Parameters<typeof createPluginContext>[0]['nativeToolRegistry'],
    routeRegistry: {
      register: stub,
      disposeBySource: () => 0,
    } as unknown as Parameters<typeof createPluginContext>[0]['routeRegistry'],
    jobScheduler: {
      register: stub,
      stopForPlugin: () => {},
    } as unknown as Parameters<typeof createPluginContext>[0]['jobScheduler'],
    ...(statusRegistry ? { pluginStatusRegistry: statusRegistry } : {}),
    logger: () => {},
  });
}

describe('Spec 004 — ctx.status', () => {
  it('is always present even without a registry, and is a no-op then', () => {
    const ctx = makeCtx('caller');
    assert.equal(typeof ctx.status.report, 'function');
    assert.equal(typeof ctx.status.clear, 'function');
    assert.doesNotThrow(() => ctx.status.report({ state: 'needs_action' }));
    assert.doesNotThrow(() => ctx.status.clear());
  });

  it('report writes to the registry under the plugin id', () => {
    const reg = new PluginStatusRegistry();
    const ctx = makeCtx('caller', reg);
    ctx.status.report({ state: 'needs_action', title: 'Nicht verbunden', detail: 'd' });
    assert.deepEqual(reg.get('caller'), {
      state: 'needs_action',
      title: 'Nicht verbunden',
      detail: 'd',
    });
  });

  it('report({state:ok}) and clear() both leave no entry', () => {
    const reg = new PluginStatusRegistry();
    const ctx = makeCtx('caller', reg);
    ctx.status.report({ state: 'needs_action', title: 'x' });
    ctx.status.report({ state: 'ok' });
    assert.equal(reg.get('caller'), undefined);
    ctx.status.report({ state: 'error', title: 'y' });
    ctx.status.clear();
    assert.equal(reg.get('caller'), undefined);
  });

  it('normalizes a malformed state to needs_action', () => {
    const reg = new PluginStatusRegistry();
    const ctx = makeCtx('caller', reg);
    // @ts-expect-error — deliberately invalid runtime input
    ctx.status.report({ state: 'bogus', title: 't' });
    assert.equal(reg.get('caller')?.state, 'needs_action');
  });

  it('writes only the calling plugin id (self-scoped)', () => {
    const reg = new PluginStatusRegistry();
    makeCtx('plugin-a', reg).status.report({ state: 'error' });
    makeCtx('plugin-b', reg).status.report({ state: 'needs_action' });
    assert.equal(reg.get('plugin-a')?.state, 'error');
    assert.equal(reg.get('plugin-b')?.state, 'needs_action');
  });
});
