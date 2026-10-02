import { strict as assert } from 'node:assert';
import { once } from 'node:events';
import { existsSync, promises as fs, readdirSync, readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import express from 'express';
import YAML from 'yaml';
import yazl from 'yazl';

import { checkCoreCompat, readHostPluginApiVersion } from '../src/plugins/coreCompat.js';
import type { InstalledRegistry } from '../src/plugins/installedRegistry.js';
import { InstallError, InstallService } from '../src/plugins/installService.js';
import { loadManifestFromPath, type PluginCatalog } from '../src/plugins/manifestLoader.js';
import { PackageUploadService } from '../src/plugins/packageUploadService.js';
import type { UploadedPackage, UploadedPackageStore } from '../src/plugins/uploadedPackageStore.js';
import { createPackagesRouter } from '../src/routes/packages.js';
import type { SecretVault } from '../src/secrets/vault.js';

/**
 * `compat.core` is the host range a plugin's manifest states. A plugin links
 * against the HOST's `@omadia/plugin-api` at runtime, so a range that excludes
 * this host means the plugin may not even load. The range is checked where a
 * package comes in: at upload (`package.incompatible_core`, HTTP 409) and at
 * install (`install.incompatible_core`, 409). Synthetic plugins throughout.
 */

const MIDDLEWARE = path.join(fileURLToPath(new URL('.', import.meta.url)), '..');
const HOST = '1.21.0';
const TOO_NEW = '>=1.30 <2.0';

function manifestYaml(id: string, core: string): string {
  return `schema_version: "1"

identity:
  id: "${id}"
  name: "Core Compat Fixture"
  version: "1.0.0"
  kind: "tool"
  description: "Fixture plugin for the compat.core gate."

compat:
  core: "${core}"

lifecycle:
  entry: "dist/plugin.js"
`;
}

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

function pluginZip(core: string): Promise<Buffer> {
  return buildZip({
    'manifest.yaml': manifestYaml('@test/core-compat', core),
    'dist/plugin.js': 'export async function activate() {}\n',
  });
}

function fakeStore(): UploadedPackageStore & { readonly stored: () => number } {
  const packages = new Map<string, UploadedPackage>();
  return {
    get: (id: string) => packages.get(id),
    list: () => [...packages.values()],
    register: async (pkg: UploadedPackage) => {
      packages.set(pkg.id, pkg);
    },
    stored: () => packages.size,
  } as unknown as UploadedPackageStore & { readonly stored: () => number };
}

function emptyCatalog(): PluginCatalog {
  return {
    get: () => undefined,
    load: async () => undefined,
    list: () => [],
    isBundledId: () => false,
  } as unknown as PluginCatalog;
}

const emptyRegistry = {
  list: () => [],
  get: () => undefined,
  has: () => false,
} as unknown as InstalledRegistry;

describe('checkCoreCompat', () => {
  const plugin = (compat_core: string) => ({ id: '@test/p', version: '0.3.1', compat_core });

  it('admits a host inside the range, prereleases included', () => {
    assert.equal(checkCoreCompat(plugin('>=1.0 <2.0'), HOST), null);
    assert.equal(checkCoreCompat(plugin('>=1.20 <2.0'), HOST), null);
    assert.equal(checkCoreCompat(plugin('>=1.0 <2.0'), '1.22.0-rc.1'), null);
  });

  it('refuses a host below or above the range, naming plugin, range and host', () => {
    for (const [range, host] of [
      [TOO_NEW, HOST],
      ['>=1.0 <2.0', '2.0.0'],
    ] as const) {
      const refusal = checkCoreCompat(plugin(range), host);
      assert.ok(refusal, `${range} must refuse ${host}`);
      assert.equal(refusal.reason, 'unsatisfied');
      assert.equal(refusal.compat_core, range);
      assert.equal(refusal.host_plugin_api, host);
      for (const part of ["'@test/p' 0.3.1", range, `@omadia/plugin-api ${host}`]) {
        assert.ok(refusal.message.includes(part), `${part} missing: ${refusal.message}`);
      }
    }
  });

  it('reads a missing compat.core as the loader default ">=1.0 <2.0"', () => {
    const unstated = { id: '@test/p', version: '0.3.1' };
    assert.equal(checkCoreCompat(unstated, HOST), null);
    assert.equal(checkCoreCompat(unstated, '2.0.0')?.compat_core, '>=1.0 <2.0');
  });

  it('refuses a compat.core that is not a semver range', () => {
    const refusal = checkCoreCompat(plugin('one point oh'), HOST);
    assert.equal(refusal?.reason, 'invalid_range');
  });

  it("reads this host's version from the installed @omadia/plugin-api", () => {
    const pkg = JSON.parse(
      readFileSync(path.join(MIDDLEWARE, 'packages', 'plugin-api', 'package.json'), 'utf8'),
    ) as { version: string };
    assert.equal(readHostPluginApiVersion(), pkg.version);
  });

  it('every in-tree manifest and boilerplate admits this host (bundled plugins keep loading)', () => {
    const host = readHostPluginApiVersion();
    const dirs = [
      ...readdirSync(path.join(MIDDLEWARE, 'packages')).map((d) => path.join('packages', d)),
      ...readdirSync(path.join(MIDDLEWARE, 'assets', 'boilerplate')).map((d) =>
        path.join('assets', 'boilerplate', d),
      ),
    ].filter((dir) => existsSync(path.join(MIDDLEWARE, dir, 'manifest.yaml')));
    assert.ok(dirs.length >= 20, `expected 20+ manifests, found ${dirs.length}`);
    for (const dir of dirs) {
      const doc = YAML.parse(readFileSync(path.join(MIDDLEWARE, dir, 'manifest.yaml'), 'utf8')) as {
        identity?: { id?: string; version?: string };
        compat?: { core?: string };
      };
      const refusal = checkCoreCompat(
        {
          id: doc.identity?.id ?? dir,
          version: doc.identity?.version ?? '?',
          compat_core: doc.compat?.core ?? '>=1.0 <2.0',
        },
        host,
      );
      assert.equal(refusal, null, `${dir}: ${refusal?.message ?? ''}`);
    }
  });
});

describe('compat.core at upload and install', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'core-compat-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  function uploadService(
    store: UploadedPackageStore,
    hostPluginApiVersion?: string,
  ): PackageUploadService {
    return new PackageUploadService({
      store,
      catalog: emptyCatalog(),
      packagesDir: path.join(tmp, 'packages'),
      limits: { maxBytes: 1024 * 1024, maxExtractedBytes: 4 * 1024 * 1024, maxEntries: 50 },
      hostDependencies: {},
      ...(hostPluginApiVersion !== undefined ? { hostPluginApiVersion } : {}),
      log: () => undefined,
    });
  }

  async function ingest(service: PackageUploadService, core: string) {
    return service.ingest({
      fileBuffer: await pluginZip(core),
      originalFilename: 'core-compat.zip',
      uploadedBy: 'test@example.com',
    });
  }

  it('ingest refuses a package whose compat.core excludes the host and stores nothing', async () => {
    const store = fakeStore();
    const result = await ingest(uploadService(store, HOST), TOO_NEW);
    assert.equal(result.ok, false);
    assert.ok(!result.ok);
    assert.equal(result.code, 'package.incompatible_core');
    assert.ok(result.message.includes(TOO_NEW), result.message);
    assert.deepEqual(result.details, { compat_core: TOO_NEW, host_plugin_api: HOST });
    assert.equal(store.stored(), 0);
  });

  it('ingest accepts a package whose compat.core admits the host', async () => {
    const store = fakeStore();
    const pinned = await ingest(uploadService(store, '1.30.2'), TOO_NEW);
    assert.equal(pinned.ok, true, JSON.stringify(pinned));
    // Unpinned, the gate reads this host's own plugin-api.
    const store2 = fakeStore();
    const real = await ingest(uploadService(store2), '>=1.0 <2.0');
    assert.equal(real.ok, true, JSON.stringify(real));
  });

  it('the upload route answers the refusal with HTTP 409', async () => {
    const store = fakeStore();
    const app = express();
    app.use(
      '/packages',
      createPackagesRouter({
        service: uploadService(store, HOST),
        store,
        registry: emptyRegistry,
        catalog: emptyCatalog(),
        maxBytes: 1024 * 1024,
      }),
    );
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const { port } = server.address() as AddressInfo;
      const form = new FormData();
      const zip = new Uint8Array(await pluginZip(TOO_NEW));
      form.append('file', new Blob([zip], { type: 'application/zip' }), 'core-compat.zip');
      const res = await fetch(`http://127.0.0.1:${String(port)}/packages/upload`, {
        method: 'POST',
        body: form,
      });
      const body = (await res.json()) as { code?: string; details?: unknown };
      assert.equal(res.status, 409);
      assert.equal(body.code, 'package.incompatible_core');
      assert.deepEqual(body.details, { compat_core: TOO_NEW, host_plugin_api: HOST });
    } finally {
      server.close();
    }
  });

  async function installService(core: string, hostPluginApiVersion: string): Promise<InstallService> {
    const manifestPath = path.join(tmp, 'manifest.yaml');
    await fs.writeFile(manifestPath, manifestYaml('@test/core-compat', core));
    const entry = await loadManifestFromPath(manifestPath);
    assert.ok(entry, 'fixture manifest parses');
    const catalog = {
      get: (id: string) => (id === entry.plugin.id ? entry : undefined),
      list: () => [entry],
    } as unknown as PluginCatalog;
    return new InstallService({
      catalog,
      registry: emptyRegistry,
      vault: {} as unknown as SecretVault,
      hostPluginApiVersion,
    });
  }

  it('install refuses a catalog entry whose compat.core excludes the host with 409', async () => {
    const service = await installService(TOO_NEW, HOST);
    assert.throws(
      () => service.create('@test/core-compat'),
      (err: unknown) =>
        err instanceof InstallError &&
        err.code === 'install.incompatible_core' &&
        err.status === 409 &&
        err.message.includes(TOO_NEW) &&
        err.message.includes(HOST),
    );
  });

  it('install accepts a catalog entry whose compat.core admits the host', async () => {
    const service = await installService(TOO_NEW, '1.30.0');
    const job = service.create('@test/core-compat');
    assert.equal(job.plugin_id, '@test/core-compat');
  });
});
