import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { Plugin } from '../src/api/admin-v1.js';
import {
  blockActivation,
  type InstalledAgent,
  type InstalledRegistry,
} from '../src/plugins/installedRegistry.js';
import {
  extractSetupSchema,
  InstallError,
  InstallService,
  purgePluginAgentBindings,
} from '../src/plugins/installService.js';
import type { AgentPluginBindingStore } from '../src/plugins/installService.js';
import type {
  PluginCatalog,
  PluginCatalogEntry,
} from '../src/plugins/manifestLoader.js';
import type { SecretVault } from '../src/secrets/vault.js';

/**
 * S+8.5 Sub-Commit 1 — install-time capability gate.
 *
 * The interesting surface is `InstallService.create()`'s requires-check:
 * given a target plugin whose `requires:` chain isn't fully covered by
 * active installed providers, the service must throw a 409
 * `install.missing_capability` with `details.available_providers` (a
 * topo-ordered chain that the wizard can render directly).
 *
 * Pre-S+8.5 the check did not exist — boot-time `resolveCapabilities`
 * threw at activation. We now block at install-time, in addition to the
 * runtime soft-fail.
 */

type Partial_Plugin = Pick<
  Plugin,
  'id' | 'provides' | 'requires' | 'depends_on'
> & {
  kind?: Plugin['kind'];
  name?: string;
};

function makePlugin(p: Partial_Plugin): Plugin {
  return {
    id: p.id,
    kind: p.kind ?? 'tool',
    multi_instance: false,
    privacy_class: 'default',
    name: p.name ?? p.id,
    version: '0.1.0',
    latest_version: '0.1.0',
    description: '',
    authors: [],
    license: 'proprietary',
    icon_url: null,
    categories: [],
    domain: 'test',
    compat_core: '>=1.0 <2.0',
    signed: false,
    signed_by: null,
    setup_fields: [],
    permissions_summary: {
      memory_reads: [],
      memory_writes: [],
      graph_reads: [],
      graph_writes: [],
      network_outbound: [],
    },
    integrations_summary: [],
    install_state: 'available',
    depends_on: p.depends_on,
    jobs: [],
    provides: p.provides,
    requires: p.requires,
  };
}

function makeCatalog(plugins: Partial_Plugin[]): PluginCatalog {
  const map = new Map<
    string,
    {
      plugin: Plugin;
      manifest: unknown;
      source_path: string;
      source_kind: 'manifest-v1';
      origin: 'installed';
    }
  >();
  for (const p of plugins) {
    map.set(p.id, {
      plugin: makePlugin(p),
      manifest: {},
      source_path: `<test>/${p.id}.manifest.yaml`,
      source_kind: 'manifest-v1',
      // #794 — test fixtures are unprivileged: only the built-in package
      // store may assert 'bundled'.
      origin: 'installed',
    });
  }
  return {
    get: (id: string) => map.get(id),
    list: () => Array.from(map.values()),
  } as unknown as PluginCatalog;
}

function makeRegistry(active: InstalledAgent[] = []): InstalledRegistry {
  const map = new Map<string, InstalledAgent>();
  for (const a of active) map.set(a.id, a);
  return {
    list: () => Array.from(map.values()),
    get: (id) => map.get(id),
    has: (id) => map.has(id),
    register: async (entry) => {
      map.set(entry.id, entry);
    },
    remove: async (id) => {
      map.delete(id);
    },
    markActivationBlocked: async (id: string, error: string) => {
      const current = map.get(id);
      if (current) {
        map.set(id, blockActivation(current, error, new Date().toISOString()));
      }
    },
    markActivationFailed: async () => {
      /* no-op */
    },
    markActivationSucceeded: async () => {
      /* no-op */
    },
    clearActivationError: async () => {
      /* no-op */
    },
    updateConfig: async () => {
      /* no-op */
    },
    updateVersion: async () => {
      /* no-op */
    },
  };
}

function makeActive(id: string): InstalledAgent {
  return {
    id,
    installed_version: '0.1.0',
    installed_at: '2026-04-29T00:00:00Z',
    status: 'active',
    config: {},
  };
}

const noopVault: SecretVault = {
  setMany: async () => {
    /* no-op */
  },
  getMany: async () => ({}),
  purge: async () => {
    /* no-op */
  },
  list: async () => [],
} as unknown as SecretVault;

describe('InstallService — agent-plugin binding cleanup (OM-95)', () => {
  it('uninstall deletes every binding for the plugin and preserves other plugins', async (t) => {
    const registry = makeRegistry([makeActive('removed'), makeActive('kept')]);
    let bindings = [
      { agentId: 'one', pluginId: 'removed', enabled: true },
      { agentId: 'two', pluginId: 'removed', enabled: false },
      { agentId: 'one', pluginId: 'kept', enabled: true },
    ];
    const calls: string[] = [];
    const teardownObservations: Array<{
      pluginId: string;
      reason: string;
      bindingCount: number;
    }> = [];
    const store: AgentPluginBindingStore = {
      deleteAgentPluginsForPlugin: async (pluginId) => {
        calls.push(pluginId);
        const before = bindings.length;
        bindings = bindings.filter((row) => row.pluginId !== pluginId);
        return before - bindings.length;
      },
    };
    const log = t.mock.method(console, 'log', () => {});
    // The registry wires later than the install service during a real boot.
    let wiredStore: AgentPluginBindingStore | undefined;
    const service = new InstallService({
      catalog: makeCatalog([]),
      registry,
      vault: noopVault,
      agentPluginBindingStore: () => wiredStore,
      onUninstall: async (pluginId, reason) => {
        teardownObservations.push({
          pluginId,
          reason,
          bindingCount: bindings.length,
        });
        wiredStore = undefined;
      },
    });
    wiredStore = store;

    await service.uninstall('removed');

    assert.deepEqual(calls, ['removed']);
    assert.deepEqual(bindings, [
      { agentId: 'one', pluginId: 'kept', enabled: true },
    ]);
    assert.equal(registry.has('removed'), false);
    assert.equal(registry.has('kept'), true);
    assert.deepEqual(teardownObservations, [
      { pluginId: 'removed', reason: 'uninstall', bindingCount: 1 },
    ]);
    assert.equal(wiredStore, undefined, 'runtime teardown removed the store');
    assert.deepEqual(log.mock.calls.map((call) => call.arguments), [
      ['[install] removed 2 agent-plugin binding(s) for removed'],
    ]);
  });

  it('uninstall completes silently when the plugin has no bindings', async (t) => {
    const registry = makeRegistry([makeActive('unbound')]);
    const calls: string[] = [];
    const log = t.mock.method(console, 'log', () => {});
    const error = t.mock.method(console, 'error', () => {});
    const service = new InstallService({
      catalog: makeCatalog([]),
      registry,
      vault: noopVault,
      agentPluginBindingStore: () => ({
        deleteAgentPluginsForPlugin: async (pluginId) => {
          calls.push(pluginId);
          return 0;
        },
      }),
    });

    await service.uninstall('unbound');

    assert.deepEqual(calls, ['unbound']);
    assert.equal(registry.has('unbound'), false);
    assert.equal(log.mock.callCount(), 0);
    assert.equal(error.mock.callCount(), 0);
  });

  it('uninstall works when no orchestrator getter is wired', async (t) => {
    const registry = makeRegistry([makeActive('standalone')]);
    const log = t.mock.method(console, 'log', () => {});
    const error = t.mock.method(console, 'error', () => {});
    const service = new InstallService({
      catalog: makeCatalog([]),
      registry,
      vault: noopVault,
    });

    await service.uninstall('standalone');

    assert.equal(registry.has('standalone'), false);
    assert.equal(log.mock.callCount(), 0);
    assert.equal(error.mock.callCount(), 0);
  });

  it('uninstall works when the orchestrator getter has no store yet', async (t) => {
    const registry = makeRegistry([makeActive('standalone')]);
    const log = t.mock.method(console, 'log', () => {});
    const error = t.mock.method(console, 'error', () => {});
    const service = new InstallService({
      catalog: makeCatalog([]),
      registry,
      vault: noopVault,
      agentPluginBindingStore: () => undefined,
    });

    await service.uninstall('standalone');

    assert.equal(registry.has('standalone'), false);
    assert.equal(log.mock.callCount(), 0);
    assert.equal(error.mock.callCount(), 0);
  });

  it('uninstall logs a database failure with plugin context and still removes the plugin', async (t) => {
    const registry = makeRegistry([makeActive('db-down')]);
    const error = t.mock.method(console, 'error', () => {});
    const service = new InstallService({
      catalog: makeCatalog([]),
      registry,
      vault: noopVault,
      agentPluginBindingStore: () => ({
        deleteAgentPluginsForPlugin: async () => {
          throw new Error('database unavailable');
        },
      }),
    });

    await assert.doesNotReject(service.uninstall('db-down'));

    assert.equal(registry.has('db-down'), false);
    assert.deepEqual(error.mock.calls.map((call) => call.arguments), [
      [
        '[install] agent-plugin binding purge failed for db-down:',
        'database unavailable',
      ],
    ]);
  });

  it('uninstall also contains a failure resolving the binding store', async (t) => {
    const registry = makeRegistry([makeActive('lookup-down')]);
    const error = t.mock.method(console, 'error', () => {});
    const service = new InstallService({
      catalog: makeCatalog([]),
      registry,
      vault: noopVault,
      agentPluginBindingStore: () => {
        throw new Error('service lookup unavailable');
      },
    });

    await assert.doesNotReject(service.uninstall('lookup-down'));

    assert.equal(registry.has('lookup-down'), false);
    assert.deepEqual(error.mock.calls.map((call) => call.arguments), [
      [
        '[install] agent-plugin binding purge failed for lookup-down:',
        'service lookup unavailable',
      ],
    ]);
  });

  it('reactivate tears down and restarts the plugin without deleting bindings', async () => {
    const registry = makeRegistry([makeActive('configured')]);
    let bindings = [{ agentId: 'one', pluginId: 'configured', enabled: true }];
    const hooks: string[] = [];
    let storeLookups = 0;
    const service = new InstallService({
      catalog: makeCatalog([]),
      registry,
      vault: noopVault,
      onUninstall: async (pluginId, reason) => {
        hooks.push(`teardown:${pluginId}:${reason}`);
      },
      onInstalled: async (pluginId) => {
        hooks.push(`activate:${pluginId}`);
      },
      agentPluginBindingStore: () => {
        storeLookups++;
        return {
          deleteAgentPluginsForPlugin: async () => {
            const removed = bindings.length;
            bindings = [];
            return removed;
          },
        };
      },
    });

    const status = await service.reactivate('configured');

    assert.deepEqual(hooks, [
      'teardown:configured:reactivate',
      'activate:configured',
    ]);
    assert.equal(status, 'active');
    assert.equal(registry.has('configured'), true);
    assert.equal(storeLookups, 0);
    assert.deepEqual(bindings, [
      { agentId: 'one', pluginId: 'configured', enabled: true },
    ]);
  });

  it('exposes cleanup independently for bootstrap removal and repeated calls are silent', async (t) => {
    let bindings = [{ agentId: 'one', pluginId: 'auto-removed' }];
    const store: AgentPluginBindingStore = {
      deleteAgentPluginsForPlugin: async (pluginId) => {
        const before = bindings.length;
        bindings = bindings.filter((row) => row.pluginId !== pluginId);
        return before - bindings.length;
      },
    };
    const log = t.mock.method(console, 'log', () => {});

    await purgePluginAgentBindings('auto-removed', () => store);
    await purgePluginAgentBindings('auto-removed', () => store);

    assert.deepEqual(bindings, []);
    assert.deepEqual(log.mock.calls.map((call) => call.arguments), [
      ['[install] removed 1 agent-plugin binding(s) for auto-removed'],
    ]);
  });

  it('independent cleanup logs non-Error rejections without throwing', async (t) => {
    const error = t.mock.method(console, 'error', () => {});
    const store: AgentPluginBindingStore = {
      deleteAgentPluginsForPlugin: () => Promise.reject('connection closed'),
    };

    await assert.doesNotReject(
      purgePluginAgentBindings('auto-removed', () => store),
    );

    assert.deepEqual(error.mock.calls.map((call) => call.arguments), [
      [
        '[install] agent-plugin binding purge failed for auto-removed:',
        'connection closed',
      ],
    ]);
  });
});

describe('InstallService.create — capability gate', () => {
  it('allows install when target has no requires', () => {
    const cat = makeCatalog([
      { id: 'standalone', provides: [], requires: [], depends_on: [] },
    ]);
    const service = new InstallService({
      catalog: cat,
      registry: makeRegistry(),
      vault: noopVault,
    });
    const job = service.create('standalone');
    assert.equal(job.plugin_id, 'standalone');
    assert.equal(job.state, 'awaiting_config');
  });

  it('allows install when every requires is covered by an active provider', () => {
    const cat = makeCatalog([
      { id: 'kg', provides: ['knowledgeGraph@1'], requires: [], depends_on: [] },
      {
        id: 'consumer',
        provides: [],
        requires: ['knowledgeGraph@^1'],
        depends_on: [],
      },
    ]);
    const service = new InstallService({
      catalog: cat,
      registry: makeRegistry([makeActive('kg')]),
      vault: noopVault,
    });
    const job = service.create('consumer');
    assert.equal(job.plugin_id, 'consumer');
    assert.equal(job.state, 'awaiting_config');
  });

  it('blocks install with 409 install.missing_capability when a requires has no active provider', () => {
    const cat = makeCatalog([
      { id: 'kg', provides: ['knowledgeGraph@1'], requires: [], depends_on: [] },
      {
        id: 'consumer',
        provides: [],
        requires: ['knowledgeGraph@^1'],
        depends_on: [],
      },
    ]);
    // KG plugin exists in catalog but is NOT installed → consumer install
    // must fail with the chain pointing operator at the missing provider.
    const service = new InstallService({
      catalog: cat,
      registry: makeRegistry(),
      vault: noopVault,
    });

    let caught: InstallError | undefined;
    try {
      service.create('consumer');
    } catch (err) {
      assert.ok(err instanceof InstallError);
      caught = err;
    }
    assert.ok(caught, 'expected InstallError to be thrown');
    assert.equal(caught.code, 'install.missing_capability');
    assert.equal(caught.status, 409);
    const details = caught.details as
      | {
          unresolved_requires: string[];
          available_providers: Array<{
            capability: string;
            providers: Array<{ id: string }>;
          }>;
        }
      | undefined;
    assert.ok(details, 'expected details payload');
    assert.deepEqual(details.unresolved_requires, ['knowledgeGraph@^1']);
    assert.equal(details.available_providers.length, 1);
    assert.deepEqual(
      details.available_providers[0]?.providers.map((p) => p.id),
      ['kg'],
    );
  });

  it('surfaces transitive pre-requisites in details (server-side, no client recursion needed)', () => {
    // confluence → kg-neon → embeddings
    const cat = makeCatalog([
      {
        id: 'embeddings',
        provides: ['embeddingClient@1'],
        requires: [],
        depends_on: [],
      },
      {
        id: 'kg-neon',
        provides: ['knowledgeGraph@1'],
        requires: ['embeddingClient@^1'],
        depends_on: [],
      },
      {
        id: 'confluence',
        provides: [],
        requires: ['knowledgeGraph@^1'],
        depends_on: [],
      },
    ]);
    const service = new InstallService({
      catalog: cat,
      registry: makeRegistry(),
      vault: noopVault,
    });

    let caught: InstallError | undefined;
    try {
      service.create('confluence');
    } catch (err) {
      caught = err as InstallError;
    }
    assert.ok(caught instanceof InstallError);
    const details = caught.details as
      | { unresolved_requires: string[] }
      | undefined;
    assert.ok(details);
    // Deepest first — embeddings must be installed before kg-neon, kg-neon
    // before confluence. Frontend wizard installs in the order returned.
    assert.deepEqual(details.unresolved_requires, [
      'embeddingClient@^1',
      'knowledgeGraph@^1',
    ]);
  });

  it('returns empty providers list when the catalog has no candidate at all', () => {
    const cat = makeCatalog([
      {
        id: 'orphan',
        provides: [],
        requires: ['neverProvided@^1'],
        depends_on: [],
      },
    ]);
    const service = new InstallService({
      catalog: cat,
      registry: makeRegistry(),
      vault: noopVault,
    });
    let caught: InstallError | undefined;
    try {
      service.create('orphan');
    } catch (err) {
      caught = err as InstallError;
    }
    assert.ok(caught instanceof InstallError);
    const details = caught.details as
      | {
          available_providers: Array<{
            capability: string;
            providers: unknown[];
          }>;
        }
      | undefined;
    assert.equal(details?.available_providers[0]?.providers.length, 0);
  });

  it('still rejects an unknown plugin id with store.plugin_not_found', () => {
    const cat = makeCatalog([
      { id: 'a', provides: [], requires: [], depends_on: [] },
    ]);
    const service = new InstallService({
      catalog: cat,
      registry: makeRegistry(),
      vault: noopVault,
    });
    assert.throws(
      () => service.create('does-not-exist'),
      (err: Error) => {
        assert.ok(err instanceof InstallError);
        assert.equal(err.code, 'store.plugin_not_found');
        assert.equal(err.status, 404);
        return true;
      },
    );
  });

  it('still rejects an already-installed plugin', () => {
    const cat = makeCatalog([
      { id: 'a', provides: [], requires: [], depends_on: [] },
    ]);
    const service = new InstallService({
      catalog: cat,
      registry: makeRegistry([makeActive('a')]),
      vault: noopVault,
    });
    assert.throws(
      () => service.create('a'),
      (err: Error) => {
        assert.ok(err instanceof InstallError);
        assert.equal(err.code, 'install.already_installed');
        assert.equal(err.status, 409);
        return true;
      },
    );
  });
});

describe('InstallService.create — provides-collision gate', () => {
  it('blocks install with 409 install.capability_already_provided when an active plugin already publishes the same <name>@<major>', () => {
    // Two siblings declare the same capability — the kg-inmemory / kg-neon
    // shape. Once one is active, installing the other must be refused at
    // install-time so the registry can never end up with two active
    // providers of `knowledgeGraph@1` (which would crash boot in
    // `buildProviderIndex`).
    const cat = makeCatalog([
      { id: 'kg-neon', provides: ['knowledgeGraph@1'], requires: [], depends_on: [] },
      {
        id: 'kg-inmemory',
        provides: ['knowledgeGraph@1'],
        requires: [],
        depends_on: [],
      },
    ]);
    const service = new InstallService({
      catalog: cat,
      registry: makeRegistry([makeActive('kg-neon')]),
      vault: noopVault,
    });

    let caught: InstallError | undefined;
    try {
      service.create('kg-inmemory');
    } catch (err) {
      assert.ok(err instanceof InstallError);
      caught = err;
    }
    assert.ok(caught, 'expected InstallError to be thrown');
    assert.equal(caught.code, 'install.capability_already_provided');
    assert.equal(caught.status, 409);
    const details = caught.details as
      | { capability: string; ownerId: string }
      | undefined;
    assert.ok(details, 'expected details payload');
    assert.equal(details.capability, 'knowledgeGraph@1');
    assert.equal(details.ownerId, 'kg-neon');
  });

  it('allows install when an inactive (errored) plugin nominally provides the same capability', () => {
    // Only `active` providers count as live owners — a plugin marked
    // errored has not run `ctx.services.provide`, so its slot is free.
    const cat = makeCatalog([
      { id: 'kg-neon', provides: ['knowledgeGraph@1'], requires: [], depends_on: [] },
      {
        id: 'kg-inmemory',
        provides: ['knowledgeGraph@1'],
        requires: [],
        depends_on: [],
      },
    ]);
    const erroredNeon: InstalledAgent = {
      ...makeActive('kg-neon'),
      status: 'errored',
    };
    const service = new InstallService({
      catalog: cat,
      registry: makeRegistry([erroredNeon]),
      vault: noopVault,
    });
    const job = service.create('kg-inmemory');
    assert.equal(job.plugin_id, 'kg-inmemory');
    assert.equal(job.state, 'awaiting_config');
  });

  it('allows install when no installed plugin claims the candidate capability', () => {
    const cat = makeCatalog([
      { id: 'kg-neon', provides: ['knowledgeGraph@1'], requires: [], depends_on: [] },
    ]);
    const service = new InstallService({
      catalog: cat,
      registry: makeRegistry(),
      vault: noopVault,
    });
    const job = service.create('kg-neon');
    assert.equal(job.plugin_id, 'kg-neon');
  });
});

describe('InstallError.details', () => {
  it('exposes details as a public, optional field', () => {
    const err = new InstallError('x', 'msg', 409, { a: 1 });
    assert.deepEqual(err.details, { a: 1 });
  });

  it('leaves details undefined when not provided (backward compat)', () => {
    const err = new InstallError('x', 'msg', 409);
    assert.equal(err.details, undefined);
  });
});

describe('extractSetupSchema — multiline flag', () => {
  function makeEntry(fields: unknown[]): PluginCatalogEntry {
    return {
      plugin: makePlugin({
        id: 'multiline-test',
        provides: [],
        requires: [],
        depends_on: [],
      }),
      manifest: { setup: { fields } },
      source_path: '<test>/multiline-test.manifest.yaml',
      source_kind: 'manifest-v1',
      // #794 — test fixtures are unprivileged: only the built-in package
      // store may assert 'bundled'.
      origin: 'installed',
    } as unknown as PluginCatalogEntry;
  }

  function fieldByKey(
    schema: ReturnType<typeof extractSetupSchema>,
    key: string,
  ) {
    return schema?.fields.find((f) => f.key === key);
  }

  it('passes multiline: true through for secret and string fields', () => {
    const schema = extractSetupSchema(
      makeEntry([
        { key: 'private_key', type: 'secret', label: 'Key', multiline: true },
        { key: 'notes', type: 'string', label: 'Notes', multiline: true },
      ]),
    );
    assert.equal(fieldByKey(schema, 'private_key')?.multiline, true);
    assert.equal(fieldByKey(schema, 'notes')?.multiline, true);
  });

  it('leaves multiline undefined when the manifest does not set it', () => {
    const schema = extractSetupSchema(
      makeEntry([{ key: 'token', type: 'secret', label: 'Token' }]),
    );
    assert.equal(fieldByKey(schema, 'token')?.multiline, undefined);
  });

  it('ignores multiline on non-text field types', () => {
    const schema = extractSetupSchema(
      makeEntry([
        { key: 'count', type: 'integer', label: 'Count', multiline: true },
        { key: 'endpoint', type: 'url', label: 'URL', multiline: true },
      ]),
    );
    assert.equal(fieldByKey(schema, 'count')?.multiline, undefined);
    assert.equal(fieldByKey(schema, 'endpoint')?.multiline, undefined);
  });

  it('ignores non-boolean multiline values', () => {
    const schema = extractSetupSchema(
      makeEntry([
        { key: 'pem', type: 'secret', label: 'PEM', multiline: 'yes' },
      ]),
    );
    assert.equal(fieldByKey(schema, 'pem')?.multiline, undefined);
  });
});

describe('extractSetupSchema — install_hidden flag', () => {
  function makeEntry(fields: unknown[]): PluginCatalogEntry {
    return {
      plugin: makePlugin({
        id: 'install-hidden-test',
        provides: [],
        requires: [],
        depends_on: [],
      }),
      manifest: { setup: { fields } },
      source_path: '<test>/install-hidden-test.manifest.yaml',
      source_kind: 'manifest-v1',
      // #794 — test fixtures are unprivileged: only the built-in package
      // store may assert 'bundled'.
      origin: 'installed',
    } as unknown as PluginCatalogEntry;
  }

  function fieldByKey(
    schema: ReturnType<typeof extractSetupSchema>,
    key: string,
  ) {
    return schema?.fields.find((f) => f.key === key);
  }

  it('passes install_hidden: true through (any field type)', () => {
    const schema = extractSetupSchema(
      makeEntry([
        { key: 'app_id', type: 'string', label: 'App ID', install_hidden: true },
        { key: 'org', type: 'string', label: 'Org' },
      ]),
    );
    assert.equal(fieldByKey(schema, 'app_id')?.install_hidden, true);
    assert.equal(fieldByKey(schema, 'org')?.install_hidden, undefined);
  });

  it('ignores non-boolean install_hidden values', () => {
    const schema = extractSetupSchema(
      makeEntry([
        { key: 'app_id', type: 'string', label: 'App ID', install_hidden: 'yes' },
      ]),
    );
    assert.equal(fieldByKey(schema, 'app_id')?.install_hidden, undefined);
  });
});
