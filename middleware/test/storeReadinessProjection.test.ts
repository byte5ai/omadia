/**
 * OM-16 — the store endpoints must carry `readiness` AND must not disturb
 * `install_state`.
 *
 * The second half is the load-bearing part: 20+ call sites (store.ts,
 * store/[id]/page.tsx, store/page.tsx, operatorAgents.ts, profiles.ts,
 * dependencyChainResolver.ts) branch on `install_state === 'installed'`.
 * Readiness is an orthogonal, additive field — never a widening of
 * `PluginInstallState`.
 */

import { describe, it, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';

import { createStoreRouter } from '../src/routes/store.js';
import type { Plugin, PluginSetupField } from '../src/api/admin-v1.js';
import type { PluginCatalog } from '../src/plugins/manifestLoader.js';
import { InMemoryInstalledRegistry } from '../src/plugins/installedRegistry.js';
import { listenLoopback } from './_helpers/listenLoopback.js';

function plugin(id: string, over: Partial<Plugin> = {}): Plugin {
  return {
    id,
    kind: 'tool',
    name: id,
    version: '1.0.0',
    latest_version: '1.0.0',
    description: '',
    authors: [],
    license: 'MIT',
    icon_url: null,
    categories: [],
    domain: 'x.y',
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
    depends_on: [],
    jobs: [],
    provides: [],
    requires: [],
    multi_instance: true,
    privacy_class: 'default',
    ...over,
  };
}

function fakeCatalog(plugins: Plugin[]): PluginCatalog {
  return {
    list: () => plugins.map((p) => ({ plugin: p, manifest: {} })),
    get: (id: string) => {
      const p = plugins.find((x) => x.id === id);
      return p ? { plugin: p, manifest: {} } : undefined;
    },
  } as unknown as PluginCatalog;
}

const secretField: PluginSetupField = {
  key: 'api_key',
  label: { en: 'API key' },
  type: 'secret',
};
const configField: PluginSetupField = {
  key: 'workspace',
  label: { en: 'Workspace' },
  type: 'string',
};

// Four plugins, one per readiness state, all reachable in a single GET.
const NOT_INSTALLED = '@x/not-installed';
const READY = '@x/ready';
const CONFIG_REQUIRED = '@x/config-required';
const ERRORED = '@x/errored';
const INCOMPATIBLE = '@x/incompatible';

describe('store router · readiness projection (OM-16)', () => {
  let server: Server;
  let base: string;

  before(async () => {
    const catalog = fakeCatalog([
      plugin(NOT_INSTALLED, { setup_fields: [configField] }),
      plugin(READY, { setup_fields: [configField, secretField] }),
      plugin(CONFIG_REQUIRED, { setup_fields: [configField, secretField] }),
      plugin(ERRORED, { setup_fields: [configField] }),
      plugin(INCOMPATIBLE, { install_state: 'incompatible' }),
    ]);

    const registry = new InMemoryInstalledRegistry();
    await registry.register({
      id: READY,
      installed_version: '1.0.0',
      installed_at: '2026-01-01T00:00:00.000Z',
      last_activated_at: '2026-03-03T09:00:00.000Z',
      status: 'active',
      config: { workspace: 'acme' },
    });
    await registry.register({
      id: CONFIG_REQUIRED,
      installed_version: '1.0.0',
      installed_at: '2026-01-01T00:00:00.000Z',
      status: 'active',
      // OM-16 repro: the operator emptied both fields through
      // PATCH /runtime/installed/:id/secrets — key survives, value is ''.
      config: { workspace: '' },
    });
    await registry.register({
      id: ERRORED,
      installed_version: '1.0.0',
      installed_at: '2026-01-01T00:00:00.000Z',
      status: 'errored',
      config: { workspace: 'acme' },
      last_activation_error: 'activate() threw: ECONNREFUSED',
    });
    // INCOMPATIBLE is deliberately NOT registered — install_state must stay
    // 'incompatible' and readiness must stay 'not_installed'.

    const vault = {
      listKeys: async (agentId: string): Promise<string[]> =>
        agentId === READY ? ['api_key'] : [],
    };

    const app = express();
    app.use(
      '/store/plugins',
      createStoreRouter({ catalog, registry, vault }),
    );
    server = await listenLoopback(app);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(() => {
    server.close();
  });

  async function list(): Promise<Map<string, Plugin>> {
    const res = await fetch(`${base}/store/plugins`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { items: Plugin[] };
    return new Map(body.items.map((p) => [p.id, p]));
  }

  it('GET /store/plugins carries readiness for every state', async () => {
    const items = await list();

    assert.equal(items.get(NOT_INSTALLED)?.readiness?.state, 'not_installed');

    const ready = items.get(READY)?.readiness;
    assert.equal(ready?.state, 'ready');
    assert.equal(ready?.verified_at, '2026-03-03T09:00:00.000Z');

    const needsConfig = items.get(CONFIG_REQUIRED)?.readiness;
    assert.equal(needsConfig?.state, 'config_required');
    // Both the emptied config key and the vanished vault secret are named.
    assert.deepEqual(needsConfig?.missing_fields.sort(), [
      'api_key',
      'workspace',
    ]);

    const errored = items.get(ERRORED)?.readiness;
    assert.equal(errored?.state, 'errored');
    assert.equal(errored?.error_detail, 'activate() threw: ECONNREFUSED');
  });

  it('install_state is UNCHANGED for all four states (regression guard)', async () => {
    const items = await list();
    // Registry membership — and nothing else — still drives install_state.
    assert.equal(items.get(NOT_INSTALLED)?.install_state, 'available');
    assert.equal(items.get(READY)?.install_state, 'installed');
    // The whole point of OM-16: an unusable plugin is STILL 'installed'.
    assert.equal(items.get(CONFIG_REQUIRED)?.install_state, 'installed');
    assert.equal(items.get(ERRORED)?.install_state, 'installed');
    assert.equal(items.get(INCOMPATIBLE)?.install_state, 'incompatible');
  });

  it('GET /store/plugins/:id carries readiness on the detail response', async () => {
    const res = await fetch(
      `${base}/store/plugins/${encodeURIComponent(CONFIG_REQUIRED)}`,
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      plugin: Plugin;
      install_available: boolean;
    };
    assert.equal(body.plugin.readiness?.state, 'config_required');
    assert.equal(body.plugin.install_state, 'installed');
    assert.equal(body.install_available, false);
  });

  it('a throwing vault does not break the list response', async () => {
    const catalog = fakeCatalog([plugin(READY, { setup_fields: [secretField] })]);
    const registry = new InMemoryInstalledRegistry();
    await registry.register({
      id: READY,
      installed_version: '1.0.0',
      installed_at: '2026-01-01T00:00:00.000Z',
      status: 'active',
      config: {},
    });
    const app = express();
    app.use(
      '/store/plugins',
      createStoreRouter({
        catalog,
        registry,
        vault: {
          listKeys: async (): Promise<string[]> => {
            throw new Error('vault sealed');
          },
        },
      }),
    );
    const srv = await listenLoopback(app);
    try {
      const port = (srv.address() as AddressInfo).port;
      const res = await fetch(`http://127.0.0.1:${port}/store/plugins`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as { items: Plugin[] };
      assert.equal(body.items[0]?.readiness?.state, 'ready');
    } finally {
      srv.close();
    }
  });

  it('omitting the vault dep keeps readiness working (older composition root)', async () => {
    const catalog = fakeCatalog([
      plugin(CONFIG_REQUIRED, { setup_fields: [configField] }),
    ]);
    const registry = new InMemoryInstalledRegistry();
    await registry.register({
      id: CONFIG_REQUIRED,
      installed_version: '1.0.0',
      installed_at: '2026-01-01T00:00:00.000Z',
      status: 'active',
      config: {},
    });
    const app = express();
    app.use('/store/plugins', createStoreRouter({ catalog, registry }));
    const srv = await listenLoopback(app);
    try {
      const port = (srv.address() as AddressInfo).port;
      const res = await fetch(`http://127.0.0.1:${port}/store/plugins`);
      const body = (await res.json()) as { items: Plugin[] };
      assert.equal(body.items[0]?.readiness?.state, 'config_required');
    } finally {
      srv.close();
    }
  });
});

describe('store router · LLM readiness projection (#884)', () => {
  const LLM_PLUGIN_ID = '@omadia/orchestrator';

  async function serveWithLlmVerdict(
    state: 'no_key' | 'verified',
  ): Promise<{ server: Server; base: string }> {
    const catalog = fakeCatalog([
      plugin(LLM_PLUGIN_ID, {
        setup_fields: [configField],
      }),
    ]);
    const registry = new InMemoryInstalledRegistry();
    await registry.register({
      id: LLM_PLUGIN_ID,
      installed_version: '1.0.0',
      installed_at: '2026-01-01T00:00:00.000Z',
      status: 'active',
      config: { workspace: 'acme' },
    });

    const app = express();
    app.use(
      '/store/plugins',
      createStoreRouter({
        catalog,
        registry,
        llmReadiness: {
          resolve: async () => ({ status: state }),
        },
      }),
    );
    const server = await listenLoopback(app);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return { server, base };
  }

  it('projects awaiting_llm on list and detail while keeping install_state installed', async () => {
    const { server, base } = await serveWithLlmVerdict('no_key');
    try {
      const listRes = await fetch(`${base}/store/plugins`);
      assert.equal(listRes.status, 200);
      const listBody = (await listRes.json()) as { items: Plugin[] };
      assert.equal(listBody.items[0]?.readiness?.state, 'awaiting_llm');
      assert.equal(listBody.items[0]?.install_state, 'installed');

      const detailRes = await fetch(
        `${base}/store/plugins/${encodeURIComponent(LLM_PLUGIN_ID)}`,
      );
      assert.equal(detailRes.status, 200);
      const detailBody = (await detailRes.json()) as { plugin: Plugin };
      assert.equal(detailBody.plugin.readiness?.state, 'awaiting_llm');
      assert.equal(detailBody.plugin.install_state, 'installed');
    } finally {
      server.close();
    }
  });

  it('projects ready on list and detail when the LLM provider is verified', async () => {
    const { server, base } = await serveWithLlmVerdict('verified');
    try {
      const listRes = await fetch(`${base}/store/plugins`);
      assert.equal(listRes.status, 200);
      const listBody = (await listRes.json()) as { items: Plugin[] };
      assert.equal(listBody.items[0]?.readiness?.state, 'ready');
      assert.equal(listBody.items[0]?.install_state, 'installed');

      const detailRes = await fetch(
        `${base}/store/plugins/${encodeURIComponent(LLM_PLUGIN_ID)}`,
      );
      assert.equal(detailRes.status, 200);
      const detailBody = (await detailRes.json()) as { plugin: Plugin };
      assert.equal(detailBody.plugin.readiness?.state, 'ready');
      assert.equal(detailBody.plugin.install_state, 'installed');
    } finally {
      server.close();
    }
  });
});
