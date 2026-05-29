import { describe, it, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createHash } from 'node:crypto';
import express from 'express';

import { RegistryClient, type RegistryClientDeps } from '../src/plugins/registryClient.js';
import { createStoreRouter } from '../src/routes/store.js';
import { createRegistryInstallRouter } from '../src/routes/registryInstall.js';
import type { Plugin } from '../src/api/admin-v1.js';
import type { PluginCatalog } from '../src/plugins/manifestLoader.js';
import type { InstalledRegistry } from '../src/plugins/installedRegistry.js';
import type {
  PackageUploadService,
  IngestInput,
  IngestResult,
} from '../src/plugins/packageUploadService.js';

const HUB = 'https://hub.test';
const ZIP = Buffer.from('PK\x03\x04 office plugin zip');
const ZIP_SHA = createHash('sha256').update(ZIP).digest('hex');

function indexJson(extraPlugins: unknown[] = []): string {
  return JSON.stringify({
    schema_version: '1',
    registry: { name: 'omadia-public', url: HUB },
    generated_at: '2026-05-29T12:00:00Z',
    plugins: [
      {
        id: '@omadia/plugin-office',
        name: 'Headless Office',
        kind: 'tool',
        domain: 'productivity.office',
        description: 'xlsx/docx',
        categories: ['productivity'],
        authors: [{ name: 'byte5' }],
        license: 'MIT',
        icon_url: null,
        latest_version: '0.1.0',
        versions: [
          {
            version: '0.1.0',
            compat_core: '>=1.0 <2.0',
            sha256: ZIP_SHA,
            size_bytes: ZIP.byteLength,
            download_url: `${HUB}/registry/@omadia/plugin-office/0.1.0/plugin.zip`,
            published_at: '2026-05-29T11:00:00Z',
            manifest_summary: { provides: ['office@1'], requires: [] },
          },
        ],
      },
      ...extraPlugins,
    ],
  });
}

function mockFetch(routes: Record<string, () => Response>): RegistryClientDeps['fetchImpl'] {
  return async (input) => {
    const url = typeof input === 'string' ? input : String(input);
    return routes[url]?.() ?? new Response('nf', { status: 404 });
  };
}

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
    required_secrets: [],
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

const fakeRegistry = { has: () => false } as unknown as InstalledRegistry;

// --- C3: store merge -------------------------------------------------------

describe('store router · remote registry merge (C3)', () => {
  let server: Server;
  let base: string;

  before(() => {
    const client = new RegistryClient({
      registries: [{ name: 'omadia-public', url: HUB }],
      log: () => {},
      fetchImpl: mockFetch({
        [`${HUB}/registry/index.json`]: () =>
          new Response(
            indexJson([
              // collides with a LOCAL plugin → local must win, no dup
              {
                id: '@x/dup',
                name: 'Dup Remote',
                kind: 'tool',
                domain: 'x.y',
                description: 'remote copy',
                categories: [],
                authors: [],
                license: 'MIT',
                icon_url: null,
                latest_version: '2.0.0',
                versions: [
                  {
                    version: '2.0.0',
                    compat_core: '>=1.0 <2.0',
                    sha256: ZIP_SHA,
                    size_bytes: 1,
                    download_url: `${HUB}/registry/@x/dup/2.0.0/plugin.zip`,
                    published_at: '',
                    manifest_summary: {},
                  },
                ],
              },
            ]),
          ),
      }),
    });

    const catalog = fakeCatalog([
      plugin('@x/dup', { name: 'Dup Local', install_state: 'installed' }),
      plugin('@x/localonly', { name: 'Local Only' }),
    ]);

    const app = express();
    app.use('/store', createStoreRouter({ catalog, registry: fakeRegistry, client }));
    server = app.listen(0);
    base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/store`;
  });

  after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('merges remote plugins, local wins on collision but is tagged with hub source', async () => {
    const body = (await (await fetch(base)).json()) as { items: Plugin[]; total: number };
    const byId = new Map(body.items.map((p) => [p.id, p]));

    // local-only + local-dup + remote office = 3, dup not doubled
    assert.equal(body.items.length, 3);
    assert.equal(byId.size, 3);

    // collision: the LOCAL dup wins on content (name + install_state), but is
    // now tagged with the hub `source` so it still surfaces in the Hub view.
    assert.equal(byId.get('@x/dup')!.name, 'Dup Local');
    assert.equal(byId.get('@x/dup')!.install_state, 'installed');
    assert.equal(byId.get('@x/dup')!.source?.registry, 'omadia-public');
    assert.equal(byId.get('@x/dup')!.source?.sha256, ZIP_SHA);

    // remote-only office carries a source marker + available state
    const office = byId.get('@omadia/plugin-office')!;
    assert.equal(office.install_state, 'available');
    assert.equal(office.signed, false);
    assert.equal(office.source?.registry, 'omadia-public');
    assert.equal(office.source?.sha256, ZIP_SHA);
    assert.deepEqual(office.provides, ['office@1']);
  });

  it('respects ?search across merged remote entries', async () => {
    const body = (await (await fetch(`${base}?search=headless`)).json()) as { items: Plugin[] };
    assert.deepEqual(
      body.items.map((p) => p.id),
      ['@omadia/plugin-office'],
    );
  });
});

describe('store router · degrades when a registry is down', () => {
  it('returns local items even if the registry fetch fails', async () => {
    const client = new RegistryClient({
      registries: [{ name: 'down', url: 'https://down.test' }],
      log: () => {},
      fetchImpl: mockFetch({}), // every fetch 404s
    });
    const catalog = fakeCatalog([plugin('@x/localonly')]);
    const app = express();
    app.use('/store', createStoreRouter({ catalog, registry: fakeRegistry, client }));
    const server = app.listen(0);
    const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/store`;
    try {
      const res = await fetch(base);
      assert.equal(res.status, 200);
      const body = (await res.json()) as { items: Plugin[] };
      assert.deepEqual(body.items.map((p) => p.id), ['@x/localonly']);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe('store router · detail resolves a remote-only plugin (C3)', () => {
  it('GET /:id returns the hub plugin with source; 404 for unknown', async () => {
    const client = new RegistryClient({
      registries: [{ name: 'omadia-public', url: HUB }],
      log: () => {},
      fetchImpl: mockFetch({
        [`${HUB}/registry/index.json`]: () => new Response(indexJson()),
      }),
    });
    const app = express();
    app.use('/store', createStoreRouter({ catalog: fakeCatalog([]), registry: fakeRegistry, client }));
    const server = app.listen(0);
    const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/store`;
    try {
      const res = await fetch(`${base}/${encodeURIComponent('@omadia/plugin-office')}`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as { plugin: Plugin; install_available: boolean };
      assert.equal(body.plugin.id, '@omadia/plugin-office');
      assert.equal(body.plugin.source?.registry, 'omadia-public');
      assert.equal(body.install_available, true);

      const miss = await fetch(`${base}/${encodeURIComponent('@x/ghost')}`);
      assert.equal(miss.status, 404);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

// --- C2: remote install ----------------------------------------------------

describe('registry install router (C2)', () => {
  let server: Server;
  let base: string;
  let ingestCalls: IngestInput[];
  let ingestResult: IngestResult;

  const makeClient = () =>
    new RegistryClient({
      registries: [{ name: 'omadia-public', url: HUB }],
      log: () => {},
      fetchImpl: mockFetch({
        [`${HUB}/registry/index.json`]: () => new Response(indexJson()),
        [`${HUB}/registry/@omadia/plugin-office/0.1.0/plugin.zip`]: () => new Response(ZIP),
      }),
    });

  const fakeUpload = {
    ingest: async (input: IngestInput): Promise<IngestResult> => {
      ingestCalls.push(input);
      return ingestResult;
    },
  } as unknown as PackageUploadService;

  before(() => {
    const app = express();
    app.use(express.json());
    app.use(
      '/install/registry',
      createRegistryInstallRouter({ client: makeClient(), packageUpload: fakeUpload }),
    );
    server = app.listen(0);
    base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/install/registry`;
  });

  after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  const reset = () => {
    ingestCalls = [];
    ingestResult = {
      ok: true,
      plugin_id: '@omadia/plugin-office',
      version: '0.1.0',
      // the router only reads ok/plugin_id/version; package shape is irrelevant
      package: {} as never,
    };
  };

  const post = (idPath: string) =>
    fetch(`${base}/${idPath}`, { method: 'POST', headers: { 'content-type': 'application/json' } });

  it('fetches, verifies sha256, ingests, returns the next step', async () => {
    reset();
    const res = await post(encodeURIComponent('@omadia/plugin-office'));
    assert.equal(res.status, 201);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body['plugin_id'], '@omadia/plugin-office');
    assert.equal(body['version'], '0.1.0');
    assert.equal(body['registry'], 'omadia-public');
    assert.match(String((body['next'] as Record<string, string>)['install']), /\/api\/v1\/install\/plugins\//);

    // ingest got the verified bytes + a registry-attributed uploadedBy
    assert.equal(ingestCalls.length, 1);
    assert.ok(ingestCalls[0]!.fileBuffer.equals(ZIP));
    assert.equal(ingestCalls[0]!.sha256, ZIP_SHA);
    assert.equal(ingestCalls[0]!.uploadedBy, 'registry:omadia-public');
  });

  it('404 for an unknown plugin and an unknown version', async () => {
    reset();
    assert.equal((await post(encodeURIComponent('@x/ghost'))).status, 404);
    assert.equal(
      (await fetch(`${base}/${encodeURIComponent('@omadia/plugin-office')}?version=9.9.9`, { method: 'POST' })).status,
      404,
    );
    assert.equal(ingestCalls.length, 0, 'no ingest on resolution failure');
  });

  it('422 when the ingest pipeline rejects the package', async () => {
    reset();
    ingestResult = { ok: false, code: 'package.id_conflict', message: 'collides with a built-in' };
    const res = await post(encodeURIComponent('@omadia/plugin-office'));
    assert.equal(res.status, 422);
    assert.equal((await res.json() as Record<string, unknown>)['code'], 'package.id_conflict');
  });
});

describe('registry install router · no registries configured', () => {
  it('409 when nothing is configured', async () => {
    const client = new RegistryClient({ registries: [], log: () => {} });
    const fakeUpload = { ingest: async () => ({ ok: true }) } as unknown as PackageUploadService;
    const app = express();
    app.use(express.json());
    app.use('/install/registry', createRegistryInstallRouter({ client, packageUpload: fakeUpload }));
    const server = app.listen(0);
    const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/install/registry`;
    try {
      const res = await fetch(`${base}/${encodeURIComponent('@omadia/plugin-office')}`, { method: 'POST' });
      assert.equal(res.status, 409);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
