import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import type { AddressInfo } from 'node:net';
import express from 'express';

import {
  MAX_INDEX_TIMEOUT_MS,
  RegistryClient,
  describeError,
  type RegistryClientDeps,
} from '../src/plugins/registryClient.js';
import { createStoreRouter } from '../src/routes/store.js';
import { createRegistryInstallRouter } from '../src/routes/registryInstall.js';
import type { Plugin, StoreListResponse } from '../src/api/admin-v1.js';
import type { PluginCatalog } from '../src/plugins/manifestLoader.js';
import type { InstalledRegistry } from '../src/plugins/installedRegistry.js';
import type { PackageUploadService } from '../src/plugins/packageUploadService.js';
import { listenLoopback } from './_helpers/listenLoopback.js';

/**
 * #1458 — one slow registry must not hold the store hostage: bounded fetches
 * (body included), cached outcomes, one in-flight fetch per registry.
 * #1482 — a failing registry is reported with its reason, also to the store
 * and the install route.
 */

const SHA = 'a'.repeat(64);
const silent = (): void => {};

function indexJson(registryUrl: string, ids: string[] = ['@x/remote']): string {
  return JSON.stringify({
    schema_version: '1',
    registry: { name: 'r', url: registryUrl },
    generated_at: '',
    plugins: ids.map((id) => ({
      id,
      name: id,
      kind: 'tool',
      latest_version: '1.0.0',
      versions: [
        {
          version: '1.0.0',
          sha256: SHA,
          download_url: `${registryUrl}/registry/${id}/1.0.0/plugin.zip`,
        },
      ],
    })),
  });
}

/** A fetch that never answers, like `nc -lk`, but honours the abort signal
 *  the way undici does. */
const hangingFetch: RegistryClientDeps['fetchImpl'] = (_url, init) =>
  new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => {
      reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }));
    });
  });

/** Headers arrive, then the body stalls until the signal aborts it. */
const stalledBodyFetch: RegistryClientDeps['fetchImpl'] = async (_url, init) => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"schema_version":'));
      init?.signal?.addEventListener('abort', () => {
        controller.error(new TypeError('terminated'));
      });
    },
  });
  return new Response(body, { status: 200 });
};

function counting(
  respond: () => Response | Promise<Response>,
): { fetchImpl: RegistryClientDeps['fetchImpl']; calls: () => number } {
  let n = 0;
  return {
    fetchImpl: async () => {
      n++;
      return respond();
    },
    calls: () => n,
  };
}

const REG = { name: 'pub', url: 'https://hub.test' };

describe('RegistryClient · deadline (#1458)', () => {
  it('times out a registry that never answers', async () => {
    const c = new RegistryClient({ registries: [REG], log: silent, timeoutMs: 50, fetchImpl: hangingFetch });
    const started = Date.now();
    const { errors, sources } = await c.listAll();
    assert.ok(Date.now() - started < 2_000, 'bounded by the deadline');
    assert.equal(errors[0]?.code, 'registry.timeout');
    assert.equal(sources[0]?.ok, false);
    assert.equal(sources[0]?.error?.code, 'registry.timeout');
  });

  it('the deadline covers the body, not only the headers', async () => {
    const c = new RegistryClient({ registries: [REG], log: silent, timeoutMs: 50, fetchImpl: stalledBodyFetch });
    const started = Date.now();
    const { errors } = await c.listAll();
    assert.ok(Date.now() - started < 2_000, 'a stalled body is cut off too');
    assert.equal(errors[0]?.code, 'registry.timeout');
  });

  it('clamps a configured deadline above the store budget', async () => {
    const logs: string[] = [];
    const c = new RegistryClient({
      registries: [REG],
      log: (m) => logs.push(m),
      timeoutMs: 15_000,
      fetchImpl: hangingFetch,
    });
    assert.ok(c);
    assert.ok(logs.some((l) => l.includes(`${MAX_INDEX_TIMEOUT_MS}ms`)));
    assert.ok(MAX_INDEX_TIMEOUT_MS < 10_000, 'below the web UI RSC budget');
  });
});

describe('RegistryClient · cache (#1458)', () => {
  it('reuses a fetched index instead of asking the registry again', async () => {
    const { fetchImpl, calls } = counting(() => new Response(indexJson(REG.url)));
    const c = new RegistryClient({ registries: [REG], log: silent, fetchImpl });
    await c.listAll();
    await c.listAll();
    await c.listAll();
    assert.equal(calls(), 1);
  });

  it('remembers a failure, and asks again once it expired', async () => {
    let now = 1_000_000;
    const { fetchImpl, calls } = counting(() => new Response('down', { status: 503 }));
    const c = new RegistryClient({
      registries: [REG],
      log: silent,
      fetchImpl,
      failureTtlMs: 60_000,
      now: () => now,
    });
    await c.listAll();
    await c.listAll();
    assert.equal(calls(), 1, 'a failed registry is not hammered on every view');
    now += 60_001;
    await c.listAll();
    assert.equal(calls(), 2);
  });

  it('concurrent callers share one in-flight fetch', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { fetchImpl, calls } = counting(async () => {
      await gate;
      return new Response(indexJson(REG.url));
    });
    const c = new RegistryClient({ registries: [REG], log: silent, fetchImpl });
    const all = Promise.all(Array.from({ length: 20 }, () => c.listAll()));
    release!();
    const results = await all;
    assert.equal(calls(), 1);
    assert.ok(results.every((r) => r.plugins.length === 1));
  });

  it('setRegistries drops the cache, so a changed url is fetched', async () => {
    const seen: string[] = [];
    const c = new RegistryClient({
      registries: [REG],
      log: silent,
      fetchImpl: async (url) => {
        seen.push(String(url));
        return new Response(indexJson(REG.url));
      },
    });
    await c.listAll();
    c.setRegistries([{ name: 'pub', url: 'https://other.test' }]);
    await c.listAll();
    assert.deepEqual(seen, [
      'https://hub.test/registry/index.json',
      'https://other.test/registry/index.json',
    ]);
  });

  it('a fetch still in flight when the list changes does not fill the new cache', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const seen: string[] = [];
    const c = new RegistryClient({
      registries: [REG],
      log: silent,
      fetchImpl: async (url) => {
        seen.push(String(url));
        if (String(url).startsWith(REG.url)) {
          await gate;
          return new Response(indexJson(REG.url, ['@old/plugin']));
        }
        return new Response(indexJson('https://other.test', ['@new/plugin']));
      },
    });
    const stale = c.listAll();
    c.setRegistries([{ name: 'pub', url: 'https://other.test' }]);
    release!();
    await stale;
    const fresh = await c.listAll();
    assert.deepEqual(fresh.plugins.map((p) => p.entry.id), ['@new/plugin']);
    assert.equal(seen.length, 2);
  });

  it('a failed artifact download drops the cached index', async () => {
    const { fetchImpl, calls } = counting(() => new Response(indexJson(REG.url)));
    const c = new RegistryClient({
      registries: [REG],
      log: silent,
      fetchImpl: async (url, init) =>
        String(url).endsWith('plugin.zip')
          ? new Response('gone', { status: 404 })
          : fetchImpl!(url, init),
    });
    const { plugins } = await c.listAll();
    const ver = plugins[0]!.entry.versions[0]!;
    await assert.rejects(
      c.fetchPackage({ registry: 'pub', downloadUrl: ver.download_url, sha256: ver.sha256 }),
    );
    await c.listAll();
    assert.equal(calls(), 2, 'the index is fetched again after the artifact 404');
  });

  it('logs a failure once per fetch, not once per cached read', async () => {
    const logs: string[] = [];
    const c = new RegistryClient({
      registries: [REG],
      log: (m) => logs.push(m),
      fetchImpl: async () => new Response('x', { status: 404 }),
    });
    await c.listAll();
    await c.listAll();
    assert.equal(logs.filter((l) => l.includes('unreachable')).length, 1);
  });
});

describe('RegistryClient · status and causes (#1482)', () => {
  it('reports one source per registry, in configured order', async () => {
    const c = new RegistryClient({
      registries: [REG, { name: 'down', url: 'https://down.test' }],
      log: silent,
      fetchImpl: async (url) =>
        String(url).startsWith(REG.url)
          ? new Response(indexJson(REG.url, ['@x/a', '@x/b']))
          : new Response('nope', { status: 404 }),
    });
    const { sources } = await c.listAll();
    assert.equal(sources.length, 2);
    assert.deepEqual(
      { name: sources[0]!.name, ok: sources[0]!.ok, plugin_count: sources[0]!.plugin_count },
      { name: 'pub', ok: true, plugin_count: 2 },
    );
    assert.equal(sources[1]!.name, 'down');
    assert.equal(sources[1]!.ok, false);
    assert.equal(sources[1]!.error?.code, 'registry.index_http');
    assert.match(sources[1]!.error!.message, /404/);
    assert.ok(!Number.isNaN(Date.parse(sources[1]!.checked_at)));
  });

  it('names the cause of a network error (refused redirect, ECONNREFUSED)', async () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9999'), {
      code: 'ECONNREFUSED',
    });
    const c = new RegistryClient({
      registries: [REG],
      log: silent,
      fetchImpl: async () => {
        throw new TypeError('fetch failed', { cause: refused });
      },
    });
    const { errors } = await c.listAll();
    assert.equal(errors[0]?.code, 'registry.network');
    assert.match(errors[0]!.message, /ECONNREFUSED 127\.0\.0\.1:9999/);

    assert.equal(
      describeError(new TypeError('fetch failed', { cause: new Error('unexpected redirect') })),
      'fetch failed (unexpected redirect)',
    );
    assert.equal(
      describeError(new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } })),
      'fetch failed (ENOTFOUND)',
    );
    assert.equal(describeError(new Error('plain')), 'plain');
  });
});

// --- routes ----------------------------------------------------------------

function localPlugin(id: string): Plugin {
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
      public_paths: [],
    },
    integrations_summary: [],
    install_state: 'available',
    depends_on: [],
    jobs: [],
    provides: [],
    requires: [],
    multi_instance: true,
    privacy_class: 'default',
  };
}

const catalog = {
  list: () => [{ plugin: localPlugin('@x/local'), manifest: {} }],
  get: () => undefined,
} as unknown as PluginCatalog;

const noneInstalled = {
  has: () => false,
  get: () => undefined,
  list: () => [],
} as unknown as InstalledRegistry;

async function withApp(
  mount: (app: express.Express) => void,
  run: (base: string) => Promise<void>,
): Promise<void> {
  const app = express();
  app.use(express.json());
  mount(app);
  const server = await listenLoopback(app);
  try {
    await run(`http://127.0.0.1:${String((server.address() as AddressInfo).port)}`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

describe('store router · a hanging registry (#1458)', () => {
  it('answers within the deadline with local plugins and the registry status', async () => {
    const client = new RegistryClient({
      registries: [{ name: 'haenger', url: 'http://hang.test' }],
      log: silent,
      timeoutMs: 100,
      fetchImpl: hangingFetch,
    });
    await withApp(
      (app) => app.use('/store', createStoreRouter({ catalog, registry: noneInstalled, client })),
      async (base) => {
        const started = Date.now();
        const res = await fetch(`${base}/store`);
        assert.ok(Date.now() - started < 2_000);
        assert.equal(res.status, 200);
        const body = (await res.json()) as StoreListResponse;
        assert.deepEqual(body.items.map((p) => p.id), ['@x/local']);
        assert.equal(body.registries?.length, 1);
        assert.equal(body.registries?.[0]?.name, 'haenger');
        assert.equal(body.registries?.[0]?.ok, false);
        assert.equal(body.registries?.[0]?.error?.code, 'registry.timeout');
      },
    );
  });

  it('omits `registries` when none is configured', async () => {
    const client = new RegistryClient({ registries: [], log: silent });
    await withApp(
      (app) => app.use('/store', createStoreRouter({ catalog, registry: noneInstalled, client })),
      async (base) => {
        const body = (await (await fetch(`${base}/store`)).json()) as StoreListResponse;
        assert.equal(body.registries, undefined);
      },
    );
  });
});

describe('registry install router · a registry that cannot be read (#1482)', () => {
  it('answers 502 registry_unavailable naming the registry, not 404 plugin_not_found', async () => {
    const client = new RegistryClient({
      registries: [{ name: 'omadia-public', url: 'https://hub.test' }],
      log: silent,
      fetchImpl: async () => new Response('nope', { status: 404 }),
    });
    const packageUpload = { ingest: async () => ({ ok: true }) } as unknown as PackageUploadService;
    await withApp(
      (app) =>
        app.use(
          '/install/registry',
          createRegistryInstallRouter({ client, packageUpload, catalog, registry: noneInstalled }),
        ),
      async (base) => {
        const res = await fetch(
          `${base}/install/registry/${encodeURIComponent('@omadia/integration-odoo')}`,
          { method: 'POST' },
        );
        assert.equal(res.status, 502);
        const body = (await res.json()) as { code: string; message: string };
        assert.equal(body.code, 'registry_install.registry_unavailable');
        assert.match(body.message, /omadia-public/);
        assert.match(body.message, /404/);
      },
    );
  });

  it('still answers 404 when every registry was read and the plugin is absent', async () => {
    const client = new RegistryClient({
      registries: [REG],
      log: silent,
      fetchImpl: async () => new Response(indexJson(REG.url)),
    });
    const packageUpload = { ingest: async () => ({ ok: true }) } as unknown as PackageUploadService;
    await withApp(
      (app) =>
        app.use(
          '/install/registry',
          createRegistryInstallRouter({ client, packageUpload, catalog, registry: noneInstalled }),
        ),
      async (base) => {
        const res = await fetch(`${base}/install/registry/${encodeURIComponent('@x/ghost')}`, {
          method: 'POST',
        });
        assert.equal(res.status, 404);
        assert.equal(((await res.json()) as { code: string }).code, 'registry_install.plugin_not_found');
      },
    );
  });
});
