/**
 * Spec 004 Phase A (FR-A2..A3) — runtime credential write accessors.
 *
 * Verifies that `ctx.secrets.set/delete` and `ctx.config.set` are present
 * ONLY when the manifest declares `permissions.secrets.runtime_write`, write
 * to the plugin's OWN namespace, and that config.set refuses keys that aren't
 * declared non-secret setup fields.
 */

import { strict as assert } from 'node:assert';
import { describe, it, beforeEach } from 'node:test';

import type { Plugin, PluginSetupField } from '../src/api/admin-v1.js';
import type {
  PluginCatalog,
  PluginCatalogEntry,
} from '../src/plugins/manifestLoader.js';
import { ServiceRegistry } from '../src/platform/serviceRegistry.js';
import { createPluginContext } from '../src/platform/pluginContext.js';

interface VaultCall {
  agentId: string;
  key: string;
  value?: string;
}

function makeStubs() {
  const setCalls: VaultCall[] = [];
  const deleteCalls: VaultCall[] = [];
  const configWrites: Array<{ id: string; config: Record<string, unknown> }> = [];
  const store: Record<string, Record<string, unknown>> = {
    caller: { app_id: 'old' },
  };

  const vault = {
    get: async () => undefined,
    listKeys: async () => [],
    async set(agentId: string, key: string, value: string) {
      setCalls.push({ agentId, key, value });
    },
    async deleteKey(agentId: string, key: string) {
      deleteCalls.push({ agentId, key });
    },
  } as unknown as Parameters<typeof createPluginContext>[0]['vault'];

  const registry = {
    has: () => true,
    list: () => [],
    get: (id: string) =>
      store[id] ? { config: store[id] } : undefined,
    async updateConfig(id: string, config: Record<string, unknown>) {
      configWrites.push({ id, config });
      store[id] = config;
    },
  } as unknown as Parameters<typeof createPluginContext>[0]['registry'];

  const stubNativeToolRegistry = {
    register: () => () => {},
    registerHandler: () => () => {},
  } as unknown as Parameters<
    typeof createPluginContext
  >[0]['nativeToolRegistry'];
  const stubRouteRegistry = {
    register: () => () => {},
    disposeBySource: () => 0,
  } as unknown as Parameters<typeof createPluginContext>[0]['routeRegistry'];
  const stubJobScheduler = {
    register: () => () => {},
    stopForPlugin: () => {},
  } as unknown as Parameters<typeof createPluginContext>[0]['jobScheduler'];

  return {
    setCalls,
    deleteCalls,
    configWrites,
    vault,
    registry,
    stubNativeToolRegistry,
    stubRouteRegistry,
    stubJobScheduler,
  };
}

const SETUP_FIELDS: PluginSetupField[] = [
  { key: 'app_id', label: 'App ID', type: 'string' },
  { key: 'private_key', label: 'Key', type: 'secret' },
];

function makeCatalog(runtimeWrite: boolean): PluginCatalog {
  const plugin = {
    id: 'caller',
    kind: 'integration',
    name: 'caller',
    version: '0.1.0',
    domain: 'test',
    setup_fields: SETUP_FIELDS,
    permissions_summary: {
      memory_reads: [],
      memory_writes: [],
      graph_reads: [],
      graph_writes: [],
      network_outbound: [],
      secrets_runtime_write: runtimeWrite,
    },
    depends_on: [],
    provides: [],
    requires: [],
  } as unknown as Plugin;
  const entry = {
    plugin,
    manifest: {},
    source_path: '/abs/caller/manifest.yaml',
    source_kind: 'manifest-v1',
  } as unknown as PluginCatalogEntry;
  return {
    list: () => [entry],
    get: (id: string) => (id === 'caller' ? entry : undefined),
  } as unknown as PluginCatalog;
}

function makeCtx(runtimeWrite: boolean) {
  const s = makeStubs();
  const ctx = createPluginContext({
    agentId: 'caller',
    vault: s.vault,
    registry: s.registry,
    catalog: makeCatalog(runtimeWrite),
    serviceRegistry: new ServiceRegistry(),
    nativeToolRegistry: s.stubNativeToolRegistry,
    routeRegistry: s.stubRouteRegistry,
    jobScheduler: s.stubJobScheduler,
    logger: () => {},
  });
  return { ctx, ...s };
}

describe('Spec 004 — runtime write accessors are gated', () => {
  it('omits set/delete when permissions.secrets.runtime_write is false', () => {
    const { ctx } = makeCtx(false);
    assert.equal(ctx.secrets.set, undefined);
    assert.equal(ctx.secrets.delete, undefined);
    assert.equal(ctx.config.set, undefined);
  });

  it('exposes set/delete when runtime_write is true', () => {
    const { ctx } = makeCtx(true);
    assert.equal(typeof ctx.secrets.set, 'function');
    assert.equal(typeof ctx.secrets.delete, 'function');
    assert.equal(typeof ctx.config.set, 'function');
  });
});

describe('Spec 004 — secrets.set/delete write the OWN namespace', () => {
  let h: ReturnType<typeof makeCtx>;
  beforeEach(() => {
    h = makeCtx(true);
  });

  it('secrets.set writes to vault under the plugin id', async () => {
    await h.ctx.secrets.set!('private_key', 'PEM');
    assert.deepEqual(h.setCalls, [
      { agentId: 'caller', key: 'private_key', value: 'PEM' },
    ]);
  });

  it('secrets.delete removes from the plugin namespace', async () => {
    await h.ctx.secrets.delete!('private_key');
    assert.deepEqual(h.deleteCalls, [{ agentId: 'caller', key: 'private_key' }]);
  });
});

describe('Spec 004 — config.set validates the key', () => {
  let h: ReturnType<typeof makeCtx>;
  beforeEach(() => {
    h = makeCtx(true);
  });

  it('persists a declared non-secret field, merged with existing config', async () => {
    await h.ctx.config.set!('app_id', '123456');
    assert.equal(h.configWrites.length, 1);
    assert.deepEqual(h.configWrites[0], {
      id: 'caller',
      config: { app_id: '123456' },
    });
  });

  it('rejects an undeclared key', async () => {
    await assert.rejects(
      () => h.ctx.config.set!('not_a_field', 'x'),
      /not a declared setup field/,
    );
    assert.equal(h.configWrites.length, 0);
  });

  it('rejects a secret-typed field (must go through secrets.set)', async () => {
    await assert.rejects(
      () => h.ctx.config.set!('private_key', 'x'),
      /use ctx\.secrets\.set/,
    );
    assert.equal(h.configWrites.length, 0);
  });
});
