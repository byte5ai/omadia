import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import type { AddressInfo } from 'node:net';
import express from 'express';

import { RegistryClient, type RegistryClientDeps } from '../src/plugins/registryClient.js';
import { createStoreRouter } from '../src/routes/store.js';
import type { Plugin } from '../src/api/admin-v1.js';
import type { PluginCatalog } from '../src/plugins/manifestLoader.js';
import {
  InMemoryInstalledRegistry,
  type InstalledRegistry,
} from '../src/plugins/installedRegistry.js';
import type { UploadedPackage } from '../src/plugins/uploadedPackageStore.js';
import { listenLoopback } from './_helpers/listenLoopback.js';

// #1469 / #1459 / #1457 / #1471 — what the store list and detail project from
// the local catalog, the hub index and the package store's provenance.

const HUB = 'https://hub.test';
const HUB_SHA_030 = 'a'.repeat(64);
const HUB_SHA_033 = 'b'.repeat(64);
const UPLOAD_SHA = 'c'.repeat(64);

function hubVersion(id: string, version: string, sha256: string, permissions?: unknown) {
  return {
    version,
    compat_core: '>=1.0 <2.0',
    sha256,
    size_bytes: 1,
    download_url: `${HUB}/registry/${id}/${version}/plugin.zip`,
    published_at: '',
    manifest_summary: permissions === undefined ? {} : { permissions },
  };
}

function hubEntry(
  id: string,
  name: string,
  versions: ReturnType<typeof hubVersion>[],
  over: Record<string, unknown> = {},
) {
  return {
    id,
    name,
    kind: 'agent',
    domain: 'x.y',
    description: '',
    categories: [],
    authors: [],
    license: 'MIT',
    icon_url: null,
    latest_version: versions[0]!.version,
    versions,
    ...over,
  };
}

const CONFLUENCE = '@omadia/agent-confluence';
const TODOIST = '@omadia/agent-todoist';
const DEV = '@omadia/dev-platform';

const INDEX = JSON.stringify({
  schema_version: '1',
  registry: { name: 'omadia-public', url: HUB },
  generated_at: '2026-10-16T00:00:00Z',
  plugins: [
    hubEntry(CONFLUENCE, 'Confluence Agent', [
      hubVersion(CONFLUENCE, '0.3.3', HUB_SHA_033),
      hubVersion(CONFLUENCE, '0.3.0', HUB_SHA_030),
    ]),
    hubEntry(
      TODOIST,
      'Todoist Agent',
      [
        hubVersion(TODOIST, '1.0.0', HUB_SHA_033, {
          memory: {
            reads: ['session:*', `agent:${TODOIST}:*`],
            writes: [`agent:${TODOIST}:*`],
          },
          graph: { reads: [], writes: [] },
          network: { outbound: ['api.todoist.com'] },
        }),
      ],
      { description_localized: { de: 'Aufgabenverwaltung' } },
    ),
    hubEntry(
      DEV,
      'Dev Platform',
      [
        hubVersion(DEV, '0.3.5', HUB_SHA_033, {
          sql: { migrations: 'migrations', ledger: 'plg_omadia_dev_platform_migrations' },
          secrets: { runtime_write: true },
          public_paths: ['/api/v1/dev-platform'],
          network: { outbound: ['api.github.com'] },
        }),
      ],
      { kind: 'extension' },
    ),
    // A malformed teaser must degrade to "declared none", never 500.
    hubEntry('@omadia/broken', 'Broken Teaser', [
      hubVersion('@omadia/broken', '1.0.0', HUB_SHA_033, ['not', 'an', 'object']),
    ]),
  ],
});

function fetchImpl(): RegistryClientDeps['fetchImpl'] {
  return async (input) => {
    const url = typeof input === 'string' ? input : String(input);
    return url === `${HUB}/registry/index.json`
      ? new Response(INDEX)
      : new Response('nf', { status: 404 });
  };
}

function plugin(id: string, over: Partial<Plugin> = {}): Plugin {
  return {
    id,
    kind: 'agent',
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

function installed(map: Record<string, string>): InstalledRegistry {
  const registry = new InMemoryInstalledRegistry();
  for (const [id, installed_version] of Object.entries(map)) {
    void registry.register({
      id,
      installed_version,
      installed_at: '2026-10-28T00:00:00Z',
      status: 'active',
      config: {},
    });
  }
  return registry;
}

function pkg(id: string, version: string, uploaded_by: string, sha256: string): UploadedPackage {
  return {
    id,
    version,
    path: `/tmp/${id}/${version}`,
    uploaded_at: '2026-10-28T00:00:00Z',
    uploaded_by,
    sha256,
    peers_missing: [],
    zip_bytes: 1,
    extracted_bytes: 1,
    file_count: 1,
  };
}

async function withStore(
  opts: {
    catalog: Plugin[];
    installed?: Record<string, string>;
    packages?: UploadedPackage[];
  },
  fn: (base: string) => Promise<void>,
): Promise<void> {
  const client = new RegistryClient({
    registries: [{ name: 'omadia-public', url: HUB }],
    log: () => {},
    fetchImpl: fetchImpl(),
  });
  const packages = new Map((opts.packages ?? []).map((p) => [p.id, p]));
  const app = express();
  app.use(
    '/store',
    createStoreRouter({
      catalog: fakeCatalog(opts.catalog),
      registry: installed(opts.installed ?? {}),
      client,
      uploadedPackages: { get: (id) => packages.get(id) },
    }),
  );
  const server = await listenLoopback(app);
  try {
    await fn(`http://127.0.0.1:${String((server.address() as AddressInfo).port)}/store`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

async function list(base: string, qs = ''): Promise<Plugin[]> {
  const res = await fetch(`${base}${qs}`);
  assert.equal(res.status, 200);
  return ((await res.json()) as { items: Plugin[] }).items;
}

/** The store page's partition rule (web-ui `partitionBySource`). */
function tabOf(p: Plugin): 'installed' | 'hub' | 'local' {
  if (p.install_state === 'installed' || p.install_state === 'update-available') {
    return 'installed';
  }
  return p.source ? 'hub' : 'local';
}

describe('store · hub source provenance (#1459)', () => {
  it('an operator upload of a hub id keeps no hub source, whatever its version', async () => {
    await withStore(
      {
        catalog: [plugin(CONFLUENCE, { version: '0.3.4', name: 'Confluence Agent' })],
        packages: [pkg(CONFLUENCE, '0.3.4', 'operator@example.com', UPLOAD_SHA)],
      },
      async (base) => {
        const item = (await list(base)).find((p) => p.id === CONFLUENCE)!;
        assert.equal(item.version, '0.3.4');
        assert.equal(item.source, undefined);
        assert.equal(tabOf(item), 'local');
      },
    );
  });

  it('a built-in (no package record) whose id the hub lists keeps no hub source', async () => {
    await withStore({ catalog: [plugin(CONFLUENCE, { version: '0.3.3' })] }, async (base) => {
      const item = (await list(base)).find((p) => p.id === CONFLUENCE)!;
      assert.equal(item.source, undefined);
    });
  });

  it('a hub download carries the coordinates of the version it downloaded, not the latest', async () => {
    await withStore(
      {
        catalog: [plugin(CONFLUENCE, { version: '0.3.0' })],
        packages: [pkg(CONFLUENCE, '0.3.0', 'registry:omadia-public', HUB_SHA_030)],
      },
      async (base) => {
        const item = (await list(base)).find((p) => p.id === CONFLUENCE)!;
        assert.equal(item.source?.registry, 'omadia-public');
        assert.equal(item.source?.sha256, HUB_SHA_030);
        assert.match(item.source?.download_url ?? '', /\/0\.3\.0\/plugin\.zip$/);
        assert.equal(tabOf(item), 'hub');
      },
    );
  });

  it('a download from ANOTHER registry is not tagged as this one', async () => {
    await withStore(
      {
        catalog: [plugin(CONFLUENCE, { version: '0.3.3' })],
        packages: [pkg(CONFLUENCE, '0.3.3', 'registry:private-hub', HUB_SHA_033)],
      },
      async (base) => {
        const item = (await list(base)).find((p) => p.id === CONFLUENCE)!;
        assert.equal(item.source, undefined);
      },
    );
  });

  it('an installed upload still gets update-available, without a hub source', async () => {
    await withStore(
      {
        catalog: [plugin(CONFLUENCE, { version: '0.3.0' })],
        installed: { [CONFLUENCE]: '0.3.0' },
        packages: [pkg(CONFLUENCE, '0.3.0', 'operator@example.com', UPLOAD_SHA)],
      },
      async (base) => {
        const item = (await list(base)).find((p) => p.id === CONFLUENCE)!;
        assert.equal(item.install_state, 'update-available');
        assert.equal(item.available_version, '0.3.3');
        assert.equal(item.source, undefined);
        const detail = (await (
          await fetch(`${base}/${encodeURIComponent(CONFLUENCE)}`)
        ).json()) as { plugin: Plugin };
        assert.equal(detail.plugin.install_state, 'update-available');
        assert.equal(detail.plugin.source, undefined);
      },
    );
  });
});

describe('store · one tab per plugin (#1469)', () => {
  it('the tab partition covers every item exactly once and an install moves hub → installed', async () => {
    const catalog = [
      plugin(CONFLUENCE, { version: '0.3.3' }),
      plugin('@x/local-only', { name: 'Local Only' }),
    ];
    const packages = [pkg(CONFLUENCE, '0.3.3', 'registry:omadia-public', HUB_SHA_033)];

    let before: Record<string, number> = {};
    await withStore({ catalog, packages }, async (base) => {
      const items = await list(base);
      before = count(items);
      assert.equal(before.hub! + before.local! + before.installed!, items.length);
    });
    await withStore(
      { catalog, packages, installed: { [CONFLUENCE]: '0.3.3' } },
      async (base) => {
        const items = await list(base);
        const after = count(items);
        assert.equal(after.hub! + after.local! + after.installed!, items.length);
        assert.equal(after.hub, before.hub! - 1, 'installing leaves the hub tab');
        assert.equal(after.installed, before.installed! + 1);
        const item = items.find((p) => p.id === CONFLUENCE)!;
        // The hub origin stays visible on the installed card.
        assert.equal(item.source?.registry, 'omadia-public');
      },
    );

    function count(items: Plugin[]): Record<string, number> {
      const out: Record<string, number> = { hub: 0, local: 0, installed: 0 };
      for (const p of items) out[tabOf(p)]! += 1;
      return out;
    }
  });
});

describe('store · hub-only permissions (#1457)', () => {
  it('projects the permissions the hub index ships into permissions_summary', async () => {
    await withStore({ catalog: [] }, async (base) => {
      const items = await list(base);
      const todoist = items.find((p) => p.id === TODOIST)!;
      assert.deepEqual(todoist.permissions_summary.memory_reads, [
        'session:*',
        `agent:${TODOIST}:*`,
      ]);
      assert.deepEqual(todoist.permissions_summary.memory_writes, [`agent:${TODOIST}:*`]);
      assert.deepEqual(todoist.permissions_summary.network_outbound, ['api.todoist.com']);

      const res = await fetch(`${base}/${encodeURIComponent(DEV)}`);
      const dev = ((await res.json()) as { plugin: Plugin }).plugin;
      assert.equal(dev.permissions_summary.secrets_runtime_write, true);
      assert.deepEqual(dev.permissions_summary.public_paths, ['/api/v1/dev-platform']);
      assert.equal(dev.permissions_summary.sql?.ledger, 'plg_omadia_dev_platform_migrations');

      const broken = items.find((p) => p.id === '@omadia/broken')!;
      assert.deepEqual(broken.permissions_summary.memory_reads, []);
      assert.deepEqual(broken.permissions_summary.public_paths, []);
    });
  });
});

describe('store · search + order (#1471)', () => {
  it('sorts local and hub-only entries together by display name', async () => {
    await withStore(
      { catalog: [plugin('@x/zeta', { name: 'Zeta' }), plugin('@x/alpha', { name: 'alpha' })] },
      async (base) => {
        const names = (await list(base)).map((p) => p.name);
        assert.deepEqual(names, [
          'alpha',
          'Broken Teaser',
          'Confluence Agent',
          'Dev Platform',
          'Todoist Agent',
          'Zeta',
        ]);
      },
    );
  });

  it('a search that only the hub copy matches does not re-add an installed plugin as available', async () => {
    // Local Todoist has no German description; the hub copy has one.
    await withStore(
      {
        catalog: [plugin(TODOIST, { name: 'Todoist Agent' })],
        installed: { [TODOIST]: '1.0.0' },
      },
      async (base) => {
        assert.deepEqual(await list(base, '?search=aufgaben'), []);
      },
    );
  });

  it('?search matches a localized description', async () => {
    await withStore({ catalog: [] }, async (base) => {
      const ids = (await list(base, '?search=aufgaben')).map((p) => p.id);
      assert.deepEqual(ids, [TODOIST]);
    });
  });
});
