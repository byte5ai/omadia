import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import express from 'express';

import type { Plugin } from '../../src/api/admin-v1.js';
import { InMemoryInstalledRegistry } from '../../src/plugins/installedRegistry.js';
import type {
  PluginCatalog,
  PluginCatalogEntry,
} from '../../src/plugins/manifestLoader.js';
import { createStoreRouter } from '../../src/routes/store.js';

function makePlugin(id: string, overrides: Partial<Plugin> = {}): Plugin {
  return {
    id,
    kind: 'agent',
    name: id,
    version: '0.1.0',
    latest_version: '0.1.0',
    description: '',
    authors: [],
    license: 'Proprietary',
    icon_url: null,
    categories: [],
    domain: 'test',
    compat_core: '>=1.0 <2.0',
    signed: false,
    signed_by: null,
    required_secrets: [],
    permissions_summary: {
      memory: { reads: [], writes: [] },
      graph: { reads: [], writes: [] },
      network: { outbound: [] },
      filesystem: { scratch: false },
    },
    integrations_summary: [],
    install_state: 'available',
    depends_on: [],
    jobs: [],
    provides: [],
    requires: [],
    ...overrides,
  };
}

function makeFakeCatalog(plugins: Plugin[]): PluginCatalog {
  const entries: PluginCatalogEntry[] = plugins.map((plugin) => ({
    plugin,
    manifest: {},
    source_path: `/abs/${plugin.id}/manifest.yaml`,
    source_kind: 'manifest-v1',
  }));
  return {
    list: () => entries,
    get: (id: string) => entries.find((e) => e.plugin.id === id),
  } as unknown as PluginCatalog;
}

async function callRouter(
  router: express.Router,
  url: string,
): Promise<{ status: number; body: unknown }> {
  const app = express();
  app.use(router);
  // Use the request listener directly via a fake `http.IncomingMessage`-like
  // path: spawn a one-off http server, send the request, read the response.
  const { default: http } = await import('node:http');
  return await new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('failed to bind ephemeral port'));
        return;
      }
      const port = address.port;
      http
        .get(`http://127.0.0.1:${port}${url}`, (res) => {
          let buf = '';
          res.setEncoding('utf8');
          res.on('data', (c: string) => (buf += c));
          res.on('end', () => {
            server.close();
            try {
              resolve({
                status: res.statusCode ?? 0,
                body: JSON.parse(buf),
              });
            } catch (err) {
              reject(err);
            }
          });
        })
        .on('error', (err) => {
          server.close();
          reject(err);
        });
    });
  });
}

describe('agent-reference / Store filter for is_reference_only', () => {
  it('list endpoint hides plugins flagged is_reference_only', async () => {
    const catalog = makeFakeCatalog([
      makePlugin('@omadia/agent-reference-maximum', { is_reference_only: true }),
      makePlugin('de.byte5.integration.foo'),
    ]);
    const registry = new InMemoryInstalledRegistry();
    const router = createStoreRouter({ catalog, registry });

    const { status, body } = await callRouter(router, '/');
    assert.equal(status, 200);
    const payload = body as { items: Plugin[]; total: number };
    assert.equal(payload.items.length, 1);
    assert.equal(payload.items[0]!.id, 'de.byte5.integration.foo');
    assert.equal(payload.total, 1);
  });

  it('detail endpoint returns 404 for plugins flagged is_reference_only', async () => {
    const catalog = makeFakeCatalog([
      makePlugin('@omadia/agent-reference-maximum', { is_reference_only: true }),
    ]);
    const registry = new InMemoryInstalledRegistry();
    const router = createStoreRouter({ catalog, registry });

    const { status, body } = await callRouter(
      router,
      '/@omadia/agent-reference-maximum',
    );
    assert.equal(status, 404);
    const payload = body as { code: string };
    assert.equal(payload.code, 'store.plugin_not_found');
  });

  it('list endpoint includes plugins without the flag', async () => {
    const catalog = makeFakeCatalog([
      makePlugin('de.byte5.integration.bar'),
    ]);
    const registry = new InMemoryInstalledRegistry();
    const router = createStoreRouter({ catalog, registry });

    const { status, body } = await callRouter(router, '/');
    assert.equal(status, 200);
    const payload = body as { items: Plugin[] };
    assert.equal(payload.items.length, 1);
  });
});
