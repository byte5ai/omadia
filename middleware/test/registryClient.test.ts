import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';

import {
  RegistryClient,
  RegistryError,
  type RegistryClientDeps,
} from '../src/plugins/registryClient.js';
import { parseRegistries } from '../src/config.js';
import type { RegistryIndexV1 } from '../src/api/registry-v1.js';

// --- helpers ---------------------------------------------------------------

const ZIP = Buffer.from('PK\x03\x04 fake zip payload');
const ZIP_SHA = createHash('sha256').update(ZIP).digest('hex');

function indexFixture(overrides: Partial<RegistryIndexV1> = {}): RegistryIndexV1 {
  return {
    schema_version: '1',
    registry: { name: 'omadia-public', url: 'https://hub.test' },
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
            download_url: 'https://hub.test/registry/@omadia/plugin-office/0.1.0/plugin.zip',
            published_at: '2026-05-29T11:00:00Z',
            manifest_summary: { provides: ['office@1'] },
          },
        ],
      },
    ],
    ...overrides,
  };
}

/** Build a fetch mock from a url→responder map. */
function mockFetch(
  routes: Record<string, () => Response>,
): RegistryClientDeps['fetchImpl'] {
  return async (input) => {
    const url = typeof input === 'string' ? input : String(input);
    const responder = routes[url];
    if (!responder) {
      return new Response('not found', { status: 404 });
    }
    return responder();
  };
}

const silent = () => {};

/** assert.rejects matcher that checks the RegistryError `.code` contract. */
function hasCode(code: string) {
  return (e: unknown): true => {
    assert.ok(e instanceof RegistryError, `expected RegistryError, got ${String(e)}`);
    assert.equal((e as RegistryError).code, code);
    return true;
  };
}

function client(deps: Partial<RegistryClientDeps>): RegistryClient {
  return new RegistryClient({
    registries: [{ name: 'omadia-public', url: 'https://hub.test' }],
    log: silent,
    ...deps,
  });
}

// --- parseRegistries -------------------------------------------------------

describe('parseRegistries', () => {
  it('returns [] for unset / empty', () => {
    assert.deepEqual(parseRegistries(undefined, silent), []);
    assert.deepEqual(parseRegistries('', silent), []);
    assert.deepEqual(parseRegistries('   ', silent), []);
  });

  it('parses a valid array with optional token', () => {
    const out = parseRegistries(
      '[{"name":"pub","url":"https://hub.test"},{"name":"priv","url":"https://x.io","token":"secret"}]',
      silent,
    );
    assert.equal(out.length, 2);
    assert.deepEqual(out[0], { name: 'pub', url: 'https://hub.test' });
    assert.equal(out[1]!.token, 'secret');
  });

  it('drops malformed JSON, non-array, bad entries, dup names', () => {
    assert.deepEqual(parseRegistries('{not json', silent), []);
    assert.deepEqual(parseRegistries('{"name":"x"}', silent), []); // not array
    assert.deepEqual(
      parseRegistries('[{"name":"x"},{"url":"https://y.io"}]', silent),
      [],
    ); // each missing the other field
    assert.deepEqual(
      parseRegistries('[{"name":"x","url":"not a url"}]', silent),
      [],
    );
    const dup = parseRegistries(
      '[{"name":"x","url":"https://a.io"},{"name":"x","url":"https://b.io"}]',
      silent,
    );
    assert.equal(dup.length, 1);
    assert.equal(dup[0]!.url, 'https://a.io');
  });
});

// --- fetchIndex ------------------------------------------------------------

describe('RegistryClient.fetchIndex', () => {
  const reg = { name: 'omadia-public', url: 'https://hub.test' };

  it('fetches and parses a well-formed index', async () => {
    const c = client({
      fetchImpl: mockFetch({
        'https://hub.test/registry/index.json': () =>
          new Response(JSON.stringify(indexFixture())),
      }),
    });
    const idx = await c.fetchIndex(reg);
    assert.equal(idx.schema_version, '1');
    assert.equal(idx.plugins.length, 1);
    assert.equal(idx.plugins[0]!.id, '@omadia/plugin-office');
    assert.equal(idx.plugins[0]!.versions[0]!.sha256, ZIP_SHA);
  });

  it('drops malformed plugin and version entries but keeps good ones', async () => {
    const idx = indexFixture();
    // a plugin with no valid versions, a plugin missing id, a junk version
    (idx.plugins as unknown[]).push(
      { id: '@x/broken', name: 'Broken', kind: 'tool', versions: [] },
      { name: 'No Id', kind: 'tool', versions: [{ version: '1', sha256: ZIP_SHA, download_url: 'https://hub.test/x' }] },
      {
        id: '@x/badsha',
        name: 'Bad Sha',
        kind: 'tool',
        versions: [{ version: '1', sha256: 'nothex', download_url: 'https://hub.test/x' }],
      },
    );
    const c = client({
      fetchImpl: mockFetch({
        'https://hub.test/registry/index.json': () =>
          new Response(JSON.stringify(idx)),
      }),
    });
    const out = await c.fetchIndex(reg);
    assert.equal(out.plugins.length, 1, 'only the well-formed office plugin survives');
    assert.equal(out.plugins[0]!.id, '@omadia/plugin-office');
  });

  it('throws on non-2xx', async () => {
    const c = client({
      fetchImpl: mockFetch({
        'https://hub.test/registry/index.json': () =>
          new Response('boom', { status: 500 }),
      }),
    });
    await assert.rejects(() => c.fetchIndex(reg), (e: unknown) => {
      assert.ok(e instanceof RegistryError);
      assert.equal((e as RegistryError).code, 'registry.index_http');
      return true;
    });
  });

  it('throws on invalid JSON and wrong schema_version', async () => {
    const badJson = client({
      fetchImpl: mockFetch({
        'https://hub.test/registry/index.json': () => new Response('{nope'),
      }),
    });
    await assert.rejects(() => badJson.fetchIndex(reg), hasCode('registry.index_parse'));

    const badVer = client({
      fetchImpl: mockFetch({
        'https://hub.test/registry/index.json': () =>
          new Response(JSON.stringify({ schema_version: '2', plugins: [] })),
      }),
    });
    await assert.rejects(() => badVer.fetchIndex(reg), hasCode('registry.index_version'));
  });

  it('rejects an oversized index via content-length', async () => {
    const c = client({
      maxIndexBytes: 10,
      fetchImpl: mockFetch({
        'https://hub.test/registry/index.json': () =>
          new Response(JSON.stringify(indexFixture()), {
            headers: { 'content-length': '999999' },
          }),
      }),
    });
    await assert.rejects(() => c.fetchIndex(reg), hasCode('registry.too_large'));
  });
});

// --- listAll ---------------------------------------------------------------

describe('RegistryClient.listAll', () => {
  it('merges registries, first-wins on id collision, records errors', async () => {
    const pubIdx = indexFixture();
    const privIdx = indexFixture({
      registry: { name: 'priv', url: 'https://priv.test' },
      plugins: [
        // same id as public → should be dropped (public wins)
        { ...indexFixture().plugins[0]! },
        // a unique plugin
        {
          ...indexFixture().plugins[0]!,
          id: '@priv/secret',
          name: 'Secret',
          versions: [
            {
              ...indexFixture().plugins[0]!.versions[0]!,
              download_url: 'https://priv.test/registry/@priv/secret/0.1.0/plugin.zip',
            },
          ],
        },
      ],
    });

    const c = new RegistryClient({
      log: silent,
      registries: [
        { name: 'omadia-public', url: 'https://hub.test' },
        { name: 'priv', url: 'https://priv.test', token: 'tk' },
        { name: 'down', url: 'https://down.test' },
      ],
      fetchImpl: mockFetch({
        'https://hub.test/registry/index.json': () =>
          new Response(JSON.stringify(pubIdx)),
        'https://priv.test/registry/index.json': () =>
          new Response(JSON.stringify(privIdx)),
        'https://down.test/registry/index.json': () =>
          new Response('err', { status: 503 }),
      }),
    });

    const { plugins, errors } = await c.listAll();
    const ids = plugins.map((p) => p.entry.id).sort();
    assert.deepEqual(ids, ['@omadia/plugin-office', '@priv/secret']);
    // office came from the public registry (first wins)
    const office = plugins.find((p) => p.entry.id === '@omadia/plugin-office');
    assert.equal(office!.registry, 'omadia-public');
    // the unreachable registry is reported, not thrown
    assert.equal(errors.length, 1);
    assert.equal(errors[0]!.registry, 'down');
  });

  it('passes the bearer token for private registries', async () => {
    let seenAuth: string | null = null;
    const c = new RegistryClient({
      log: silent,
      registries: [{ name: 'priv', url: 'https://priv.test', token: 'sekret' }],
      fetchImpl: async (_url, init) => {
        seenAuth =
          (init?.headers as Record<string, string> | undefined)?.[
            'Authorization'
          ] ?? null;
        return new Response(
          JSON.stringify(
            indexFixture({ registry: { name: 'priv', url: 'https://priv.test' } }),
          ),
        );
      },
    });
    await c.listAll();
    assert.equal(seenAuth, 'Bearer sekret');
  });
});

// --- fetchPackage ----------------------------------------------------------

describe('RegistryClient.fetchPackage', () => {
  const downloadUrl =
    'https://hub.test/registry/@omadia/plugin-office/0.1.0/plugin.zip';

  it('downloads and verifies sha256', async () => {
    const c = client({
      fetchImpl: mockFetch({ [downloadUrl]: () => new Response(ZIP) }),
    });
    const out = await c.fetchPackage({
      registry: 'omadia-public',
      downloadUrl,
      sha256: ZIP_SHA,
    });
    assert.equal(out.sha256, ZIP_SHA);
    assert.ok(out.buffer.equals(ZIP));
  });

  it('throws on sha256 mismatch', async () => {
    const c = client({
      fetchImpl: mockFetch({ [downloadUrl]: () => new Response(ZIP) }),
    });
    await assert.rejects(
      () =>
        c.fetchPackage({
          registry: 'omadia-public',
          downloadUrl,
          sha256: 'a'.repeat(64),
        }),
      hasCode('registry.sha256_mismatch'),
    );
  });

  it('pins the download host to the registry host', async () => {
    const c = client({
      fetchImpl: mockFetch({
        'https://evil.test/x.zip': () => new Response(ZIP),
      }),
    });
    await assert.rejects(
      () =>
        c.fetchPackage({
          registry: 'omadia-public',
          downloadUrl: 'https://evil.test/x.zip',
          sha256: ZIP_SHA,
        }),
      hasCode('registry.host_mismatch'),
    );
  });

  it('throws for an unknown registry name', async () => {
    const c = client({ fetchImpl: mockFetch({}) });
    await assert.rejects(
      () =>
        c.fetchPackage({ registry: 'nope', downloadUrl, sha256: ZIP_SHA }),
      hasCode('registry.unknown'),
    );
  });

  it('rejects an oversized artifact', async () => {
    const c = client({
      maxArtifactBytes: 4,
      fetchImpl: mockFetch({ [downloadUrl]: () => new Response(ZIP) }),
    });
    await assert.rejects(
      () =>
        c.fetchPackage({ registry: 'omadia-public', downloadUrl, sha256: ZIP_SHA }),
      hasCode('registry.too_large'),
    );
  });
});
