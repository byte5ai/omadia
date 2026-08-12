/**
 * OM-06 / #671 — the store must not offer an install the server will refuse.
 *
 * `install_available` used to be `install_state === 'available'` alone, which
 * only says "not already installed". It never asked whether the CAPABILITY was
 * taken. So a provider whose slot was already filled by an active plugin got a
 * live "Install" button, and `InstallService.create` then rejected the click
 * with 409 `install.capability_already_provided`. The reported shape of this
 * was a store page offering "Jetzt installieren" for a provider the admin area
 * already listed as connected, with nothing linking the two.
 *
 * The structured `blocked_by_active_provider` is what the client needs: the
 * operator's next step is to CONFIGURE the provider that already exists, and
 * no client can build that link by parsing an English `blocking_reasons`
 * string.
 */

import { describe, it, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';

import { createStoreRouter } from '../src/routes/store.js';
import type { Plugin } from '../src/api/admin-v1.js';
import type { PluginCatalog } from '../src/plugins/manifestLoader.js';
import { InMemoryInstalledRegistry } from '../src/plugins/installedRegistry.js';

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

const INCUMBENT = '@x/provider-active';
const RIVAL = '@x/provider-rival';
const UNRELATED = '@x/plain-tool';

interface DetailBody {
  install_available: boolean;
  blocking_reasons?: string[];
  blocked_by_active_provider?: { capability: string; owner_id: string };
}

describe('store router · already-provided capability (OM-06 / #671)', () => {
  let server: Server;
  let base: string;

  before(async () => {
    const catalog = fakeCatalog([
      plugin(INCUMBENT, { provides: ['llmProvider@1'] }),
      plugin(RIVAL, { provides: ['llmProvider@1'] }),
      plugin(UNRELATED),
    ]);

    const registry = new InMemoryInstalledRegistry();
    await registry.register({
      id: INCUMBENT,
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
        vault: { listKeys: async (): Promise<string[]> => [] },
      }),
    );
    server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(() => {
    server.close();
  });

  async function detail(id: string): Promise<DetailBody> {
    const res = await fetch(`${base}/store/plugins/${encodeURIComponent(id)}`);
    assert.equal(res.status, 200);
    return (await res.json()) as DetailBody;
  }

  it('refuses to advertise an install whose capability slot is taken', async () => {
    const body = await detail(RIVAL);
    assert.equal(
      body.install_available,
      false,
      'the button must not be live for an install the server answers with 409',
    );
  });

  it('names the incumbent in a structured field, not only in prose', async () => {
    const body = await detail(RIVAL);
    assert.deepEqual(body.blocked_by_active_provider, {
      capability: 'llmProvider@1',
      owner_id: INCUMBENT,
    });
    // The English line stays for clients that only print reasons, but it is
    // the structured field that lets the UI link to the existing provider.
    assert.ok(
      body.blocking_reasons?.some((r) => r.includes(INCUMBENT)),
      'the human-readable reason should still name the incumbent',
    );
  });

  it('leaves an unrelated plugin installable', async () => {
    const body = await detail(UNRELATED);
    assert.equal(body.install_available, true);
    assert.equal(
      body.blocked_by_active_provider,
      undefined,
      'a plugin that provides nothing must not be blocked by anyone',
    );
  });

  it('does not block the incumbent against itself', async () => {
    // It is installed, so `install_available` is false for that reason alone —
    // but it must not be reported as colliding with itself, or the UI would
    // tell the operator to configure the very plugin they are looking at.
    const body = await detail(INCUMBENT);
    assert.equal(body.blocked_by_active_provider, undefined);
  });
});
