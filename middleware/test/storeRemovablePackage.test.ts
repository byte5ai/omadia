import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import express from 'express';

import { RegistryClient } from '../src/plugins/registryClient.js';
import { createStoreRouter } from '../src/routes/store.js';
import type { Plugin } from '../src/api/admin-v1.js';
import type { PluginCatalog } from '../src/plugins/manifestLoader.js';
import type { InstalledRegistry } from '../src/plugins/installedRegistry.js';
import { listenLoopback } from './_helpers/listenLoopback.js';

/**
 * #1490 — an uploaded or Hub-fetched package that is not installed is flagged
 * `removable_package`, so the detail page can offer to remove it.
 * #1495 — a Hub package fetched but not installed keeps its Hub `source` on
 * the detail page when the Hub offers that exact version, so "Install now"
 * goes through the Hub route (and its prerequisites chain) after a reload.
 */

const HUB = 'https://hub.test';
const SHA = createHash('sha256').update('x').digest('hex');

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

const fakeRegistry = {
  // Empty fixture: every id is absent, so blocking is a no-op.
  markActivationBlocked: async () => undefined,
  has: () => false,
  get: () => undefined,
  // `list()` is not optional on InstalledRegistry — the `as unknown as` cast
  // below is what let this stub omit it. The store's already-provided check
  // (#671) walks the installed set, so a stub without `list` 500s the very
  // routes these tests assert on. Empty is the right answer here: nothing is
  // installed in these fixtures.
  list: () => [],
} as unknown as InstalledRegistry;


function hubIndex(id: string, versions: string[]): string {
  return JSON.stringify({
    schema_version: '1',
    registry: { name: 'omadia-public', url: HUB },
    generated_at: '2026-10-28T00:00:00Z',
    plugins: [
      {
        id,
        name: id,
        kind: 'agent',
        domain: 'x.y',
        description: '',
        categories: [],
        authors: [],
        license: 'MIT',
        icon_url: null,
        latest_version: versions[versions.length - 1],
        versions: versions.map((v) => ({
          version: v,
          compat_core: '>=1.0 <2.0',
          sha256: SHA,
          size_bytes: 1,
          download_url: `${HUB}/registry/${v}/plugin.zip`,
          published_at: '',
          manifest_summary: {},
        })),
      },
    ],
  });
}

async function detail(opts: {
  plugins: Plugin[];
  uploaded: string[];
  hub?: { id: string; versions: string[] };
  id: string;
}): Promise<Plugin> {
  const client = opts.hub
    ? new RegistryClient({
        registries: [{ name: 'omadia-public', url: HUB }],
        log: () => {},
        fetchImpl: async (input) =>
          String(input) === `${HUB}/registry/index.json`
            ? new Response(hubIndex(opts.hub!.id, opts.hub!.versions))
            : new Response('nf', { status: 404 }),
      })
    : undefined;
  const app = express();
  app.use(
    '/store',
    createStoreRouter({
      catalog: fakeCatalog(opts.plugins),
      registry: fakeRegistry,
      ...(client ? { client } : {}),
      uploadedPackages: {
        get: (id: string) => (opts.uploaded.includes(id) ? ({ id } as never) : undefined),
      },
    }),
  );
  const server = await listenLoopback(app);
  try {
    const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/store`;
    const res = await fetch(`${base}/${encodeURIComponent(opts.id)}`);
    assert.equal(res.status, 200);
    return ((await res.json()) as { plugin: Plugin }).plugin;
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

describe('store router · removable_package (#1490)', () => {
  it('flags an uploaded, not installed package', async () => {
    const p = await detail({
      plugins: [plugin('@x/uploaded')],
      uploaded: ['@x/uploaded'],
      id: '@x/uploaded',
    });
    assert.equal(p.removable_package, true);
  });

  it('does not flag a built-in that was never uploaded', async () => {
    const p = await detail({ plugins: [plugin('@x/builtin')], uploaded: [], id: '@x/builtin' });
    assert.equal(p.removable_package, undefined);
  });

  it('does not flag an installed plugin (removed through uninstall)', async () => {
    const p = await detail({
      plugins: [plugin('@x/inst', { install_state: 'installed' })],
      uploaded: ['@x/inst'],
      id: '@x/inst',
    });
    assert.equal(p.removable_package, undefined);
  });
});

describe('store router · Hub source on a fetched, not installed package (#1495)', () => {
  it('carries the source of the SAME version when the Hub offers it', async () => {
    const p = await detail({
      plugins: [plugin('@x/agent', { version: '0.2.8' })],
      uploaded: ['@x/agent'],
      hub: { id: '@x/agent', versions: ['0.2.8', '0.3.0'] },
      id: '@x/agent',
    });
    assert.equal(p.source?.registry, 'omadia-public');
    assert.equal(p.source?.download_url, `${HUB}/registry/0.2.8/plugin.zip`);
  });

  it('carries no source when the Hub does not offer the local version', async () => {
    const p = await detail({
      plugins: [plugin('@x/agent', { version: '9.9.9' })],
      uploaded: ['@x/agent'],
      hub: { id: '@x/agent', versions: ['0.2.8'] },
      id: '@x/agent',
    });
    assert.equal(p.source, undefined);
  });
});
