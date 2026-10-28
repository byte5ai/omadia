import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';

import express from 'express';
import yazl from 'yazl';

import {
  ingestFailureBody,
  ingestFailureStatus,
} from '../src/plugins/ingestErrorContract.js';
import {
  PackageUploadService,
  type IngestInput,
  type IngestResult,
} from '../src/plugins/packageUploadService.js';
import { createPackagesRouter } from '../src/routes/packages.js';
import { createRegistryInstallRouter } from '../src/routes/registryInstall.js';
import { InMemoryInstalledRegistry } from '../src/plugins/installedRegistry.js';
import { RegistryClient, type RegistryClientDeps } from '../src/plugins/registryClient.js';
import {
  UploadedPackageStore,
  type UploadedPackage,
} from '../src/plugins/uploadedPackageStore.js';
import type { PluginCatalog } from '../src/plugins/manifestLoader.js';
import { listenLoopback } from './_helpers/listenLoopback.js';

/**
 * Sweep 2 / N02 — one error contract for the three doors into the ingest
 * pipeline (#1477), plus the upload-route bugs that broke it: the doubled
 * `upload.upload.multipart` code and the client-trusting mimetype gate
 * (#1489), and yauzl's path-traversal refusal escaping as a 500 (#1488).
 */

const MANIFEST_YAML = `schema_version: "1"

identity:
  id: "@test/contract"
  name: "Contract"
  version: "1.0.0"
  kind: "tool"
  description: "Fixture plugin for the error contract."

compat:
  core: ">=1.0 <2.0"

lifecycle:
  entry: "dist/plugin.js"
`;

function buildZip(files: Record<string, string>): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    const chunks: Buffer[] = [];
    zip.outputStream.on('data', (c: Buffer) => chunks.push(c));
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    zip.outputStream.on('error', reject);
    for (const [name, content] of Object.entries(files)) {
      zip.addBuffer(Buffer.from(content, 'utf-8'), name, { mtime: new Date(0) });
    }
    zip.end();
  });
}

/** yazl refuses unsafe entry names, so the zip is built with a same-length
 *  placeholder and the bytes are patched afterwards (both the local header and
 *  the central directory carry the name). */
async function zipWithEntry(unsafeName: string): Promise<Buffer> {
  const placeholder = 'p'.repeat(unsafeName.length - 4) + '.txt';
  const raw = await buildZip({
    'manifest.yaml': MANIFEST_YAML,
    'dist/plugin.js': 'module.exports = { activate() {} };\n',
    [placeholder]: 'x',
  });
  const patched = Buffer.from(
    raw.toString('latin1').split(placeholder).join(unsafeName),
    'latin1',
  );
  assert.equal(patched.length, raw.length);
  return patched;
}

function fakeCatalog(): PluginCatalog {
  return {
    get: () => undefined,
    load: async () => undefined,
    list: () => [],
    isBundledId: () => false,
  } as unknown as PluginCatalog;
}

// ---------------------------------------------------------------------------

describe('ingest error contract (#1477)', () => {
  it('maps host-state conflicts and an incompatible core to 409', () => {
    for (const code of [
      'package.id_conflict_builtin',
      'package.id_conflict_bundled',
      'package.duplicate_version',
      'package.downgrade_blocked',
      'package.incompatible_core',
    ]) {
      assert.equal(ingestFailureStatus(code), 409, code);
    }
  });

  it('maps every size cap to 413', () => {
    for (const code of ['package.too_large', 'zip.file_too_large', 'zip.total_too_large']) {
      assert.equal(ingestFailureStatus(code), 413, code);
    }
  });

  it('maps everything else to 422 — never 400 or 500', () => {
    for (const code of [
      'zip.invalid',
      'zip.path_escape',
      'zip.symlink',
      'package.manifest_invalid',
      'package.entry_unscannable',
      'package.migration_failed',
      'package.something_new',
    ]) {
      assert.equal(ingestFailureStatus(code), 422, code);
    }
  });

  it('keeps params and details in the body, and only when present', () => {
    assert.deepEqual(
      ingestFailureBody({
        code: 'package.incompatible_core',
        message: 'm',
        details: { compat_core: '>=2', host_plugin_api: '1.31.0' },
      }),
      {
        code: 'package.incompatible_core',
        message: 'm',
        details: { compat_core: '>=2', host_plugin_api: '1.31.0' },
      },
    );
    assert.deepEqual(
      ingestFailureBody({ code: 'c', message: 'm', params: { pluginId: 'p' } }),
      { code: 'c', message: 'm', params: { pluginId: 'p' } },
    );
  });
});

// ---------------------------------------------------------------------------

describe('ZIP upload route — non-zip, multipart and path-escape answers', () => {
  let root: string;
  let server: Server;
  let base: string;
  let store: UploadedPackageStore;
  let logs: string[];

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'n02-upload-'));
    logs = [];
    store = new UploadedPackageStore(
      path.join(root, 'index.json'),
      path.join(root, 'packages'),
      (m) => logs.push(m),
    );
    await store.load();
    const app = express();
    app.use(
      '/packages',
      createPackagesRouter({
        service: new PackageUploadService({
          store,
          catalog: fakeCatalog(),
          packagesDir: path.join(root, 'packages'),
          limits: { maxBytes: 1024 * 1024, maxExtractedBytes: 4 * 1024 * 1024, maxEntries: 50 },
          hostDependencies: {},
          hostPluginApiVersion: '1.5.0',
          log: (m) => logs.push(m),
        }),
        store,
        registry: new InMemoryInstalledRegistry(),
        catalog: fakeCatalog(),
        maxBytes: 1024 * 1024,
        log: (m) => logs.push(m),
      }),
    );
    server = await listenLoopback(app);
    base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/packages`;
  });

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await fs.rm(root, { recursive: true, force: true });
  });

  const upload = (bytes: Buffer, filename: string, type: string): Promise<Response> => {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(bytes)], { type }), filename);
    return fetch(`${base}/upload`, { method: 'POST', body: form });
  };

  it('#1489 — the same non-zip bytes get 422 zip.invalid whatever the client declares', async () => {
    const notes = Buffer.from('hello\n');
    for (const [filename, type] of [
      ['notes.txt', 'text/plain'],
      ['notes.txt', 'application/octet-stream'],
      ['notes.zip', 'text/plain'],
    ] as const) {
      const res = await upload(notes, filename, type);
      assert.equal(res.status, 422, `${filename} ${type}`);
      assert.equal(((await res.json()) as { code: string }).code, 'zip.invalid');
    }
  });

  it('#1489 — a multipart error without its own code answers upload.multipart, once prefixed', async () => {
    const boundary = 'n02boundary';
    // A part that never ends: busboy reports "Unexpected end of form" with
    // no `code`, which is what used to come back as `upload.upload.multipart`.
    const res = await fetch(`${base}/upload`, {
      method: 'POST',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      body:
        `--${boundary}\r\n` +
        'Content-Disposition: form-data; name="file"; filename="a.zip"\r\n' +
        'Content-Type: application/zip\r\n\r\nPK',
    });
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { code: string }).code, 'upload.multipart');
  });

  // yauzl turns backslashes into slashes before it validates, so `..\\` is
  // the same escape as `../` and the entry is reported in its slash form; a
  // backslash INSIDE the package (`dir\\a.txt`) is just a folder and fine.
  for (const [unsafe, reported] of [
    ['../evil.txt', '../evil.txt'],
    ['/abs/evil.txt', '/abs/evil.txt'],
    ['..\\evil.txt', '../evil.txt'],
  ] as const) {
    it(`#1488 — ${JSON.stringify(unsafe)} answers 422 zip.path_escape naming the entry, writes nothing`, async () => {
      const res = await upload(await zipWithEntry(unsafe), 'slip.zip', 'application/zip');
      assert.equal(res.status, 422);
      const body = (await res.json()) as { code: string; params?: { entry?: string } };
      assert.equal(body.code, 'zip.path_escape');
      assert.equal(body.params?.entry, reported);
      assert.equal(store.list().length, 0);
      await assert.rejects(fs.access(path.join(root, 'evil.txt')));
    });
  }

  it('#1490 — replacing a version names the replaced one; DELETE logs and leaves no empty folder', async () => {
    const v1 = await buildZip({
      'manifest.yaml': MANIFEST_YAML,
      'dist/plugin.js': 'module.exports = { activate() {} };\n',
    });
    const v2 = await buildZip({
      'manifest.yaml': MANIFEST_YAML.replace('version: "1.0.0"', 'version: "1.0.1"'),
      'dist/plugin.js': 'module.exports = { activate() {} };\n',
    });
    assert.equal((await upload(v1, 'c.zip', 'application/zip')).status, 201);
    const second = await upload(v2, 'c.zip', 'application/zip');
    assert.equal(second.status, 201);
    const body = (await second.json()) as { replaced_version?: string; direction?: string };
    assert.equal(body.replaced_version, '1.0.0');
    assert.equal(body.direction, 'upgrade');
    assert.ok(logs.some((l) => l.includes('replaced=1.0.0')), logs.join('\n'));

    const dup = await upload(v2, 'c.zip', 'application/zip');
    assert.equal(dup.status, 409);
    const dupBody = (await dup.json()) as { message: string };
    assert.doesNotMatch(dupBody.message, /DELETE/);

    const del = await fetch(`${base}/${encodeURIComponent('@test/contract')}`, {
      method: 'DELETE',
    });
    assert.equal(del.status, 204);
    assert.ok(
      logs.some((l) => l.includes('package removed id=@test/contract version=1.0.1')),
      logs.join('\n'),
    );
    // Neither `@test/contract/` nor the `@test/` scope folder is left behind.
    const left = await fs.readdir(path.join(root, 'packages'));
    assert.deepEqual(
      left.filter((n) => n !== '.staging'),
      [],
    );
  });
});

// ---------------------------------------------------------------------------

const HUB = 'https://hub.test';
const ID = '@omadia/plugin-office';
const ZIP = Buffer.from('PK\x03\x04 office plugin zip');
const ZIP_SHA = createHash('sha256').update(ZIP).digest('hex');

function indexJson(): string {
  return JSON.stringify({
    schema_version: '1',
    registry: { name: 'omadia-public', url: HUB },
    generated_at: '2026-10-28T00:00:00Z',
    plugins: [
      {
        id: ID,
        name: 'Office',
        kind: 'tool',
        domain: 'productivity.office',
        description: '',
        categories: [],
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
            download_url: `${HUB}/registry/office/0.1.0/plugin.zip`,
            published_at: '2026-10-28T00:00:00Z',
            manifest_summary: { provides: [], requires: [] },
          },
        ],
      },
    ],
  });
}

function hubClient(downloads: string[]): RegistryClient {
  const fetchImpl: RegistryClientDeps['fetchImpl'] = async (input) => {
    const url = typeof input === 'string' ? input : String(input);
    if (url === `${HUB}/registry/index.json`) return new Response(indexJson());
    if (url === `${HUB}/registry/office/0.1.0/plugin.zip`) {
      downloads.push(url);
      return new Response(ZIP);
    }
    return new Response('nf', { status: 404 });
  };
  return new RegistryClient({
    registries: [{ name: 'omadia-public', url: HUB }],
    log: () => {},
    fetchImpl,
  });
}

function storedPackage(sha256: string): UploadedPackage {
  return {
    id: ID,
    version: '0.1.0',
    path: '/nowhere',
    uploaded_at: '2026-10-28T00:00:00Z',
    uploaded_by: 'registry:omadia-public',
    sha256,
    peers_missing: [],
    zip_bytes: ZIP.byteLength,
    extracted_bytes: 1,
    file_count: 1,
  };
}

describe('Hub install route — same contract as the upload, idempotent re-click', () => {
  async function serve(opts: {
    stored?: UploadedPackage;
    result?: IngestResult;
    downloads: string[];
    ingests: IngestInput[];
  }): Promise<{ base: string; close: () => Promise<void> }> {
    const app = express();
    app.use(
      '/registry',
      createRegistryInstallRouter({
        client: hubClient(opts.downloads),
        packageUpload: {
          ingest: async (input: IngestInput): Promise<IngestResult> => {
            opts.ingests.push(input);
            return (
              opts.result ?? {
                ok: true,
                plugin_id: ID,
                version: '0.1.0',
                package: {} as never,
              }
            );
          },
        } as unknown as PackageUploadService,
        catalog: { get: () => undefined } as unknown as PluginCatalog,
        registry: new InMemoryInstalledRegistry(),
        ...(opts.stored ? { store: { get: (id: string) => (id === ID ? opts.stored : undefined) } } : {}),
      }),
    );
    const server = await listenLoopback(app);
    return {
      base: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/registry/${encodeURIComponent(ID)}`,
      close: () => new Promise<void>((r) => server.close(() => r())),
    };
  }

  it('#1495 — the same version with the same sha256 is already present: 200, no download, no ingest', async () => {
    const downloads: string[] = [];
    const ingests: IngestInput[] = [];
    const s = await serve({ stored: storedPackage(ZIP_SHA.toUpperCase()), downloads, ingests });
    try {
      const res = await fetch(`${s.base}?version=0.1.0`, { method: 'POST' });
      assert.equal(res.status, 200);
      const body = (await res.json()) as Record<string, unknown>;
      assert.equal(body['already_present'], true);
      assert.equal(body['plugin_id'], ID);
      assert.deepEqual(body['chain'], { unresolved_requires: [], available_providers: [] });
      assert.deepEqual(downloads, []);
      assert.deepEqual(ingests, []);
    } finally {
      await s.close();
    }
  });

  it('#1495 — the same version with OTHER bytes still goes to the ingest and keeps its refusal', async () => {
    const downloads: string[] = [];
    const ingests: IngestInput[] = [];
    const s = await serve({
      stored: storedPackage('b'.repeat(64)),
      result: {
        ok: false,
        code: 'package.duplicate_version',
        message: 'bereits hochgeladen',
        params: { pluginId: ID, version: '0.1.0' },
      },
      downloads,
      ingests,
    });
    try {
      const res = await fetch(s.base, { method: 'POST' });
      // #1477 — 409 with params, as on the upload (it was 422 without them).
      assert.equal(res.status, 409);
      const body = (await res.json()) as Record<string, unknown>;
      assert.equal(body['code'], 'package.duplicate_version');
      assert.deepEqual(body['params'], { pluginId: ID, version: '0.1.0' });
      assert.equal(ingests.length, 1);
    } finally {
      await s.close();
    }
  });

  it('#1477 — an incompatible core answers 409 with its details, as on the upload', async () => {
    const s = await serve({
      result: {
        ok: false,
        code: 'package.incompatible_core',
        message: 'compat.core excludes this host',
        details: { compat_core: '>=2.0', host_plugin_api: '1.31.0' },
      },
      downloads: [],
      ingests: [],
    });
    try {
      const res = await fetch(s.base, { method: 'POST' });
      assert.equal(res.status, 409);
      const body = (await res.json()) as Record<string, unknown>;
      assert.deepEqual(body['details'], { compat_core: '>=2.0', host_plugin_api: '1.31.0' });
    } finally {
      await s.close();
    }
  });

  it('#1477 — a size refusal answers 413, as on the upload', async () => {
    const s = await serve({
      result: { ok: false, code: 'package.too_large', message: 'x', params: { maxBytes: '1' } },
      downloads: [],
      ingests: [],
    });
    try {
      const res = await fetch(s.base, { method: 'POST' });
      assert.equal(res.status, 413);
      assert.deepEqual(((await res.json()) as { params?: unknown }).params, { maxBytes: '1' });
    } finally {
      await s.close();
    }
  });
});
