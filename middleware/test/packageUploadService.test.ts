import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import express from 'express';
import yazl from 'yazl';

import { PackageUploadService } from '../src/plugins/packageUploadService.js';
import { createPackagesRouter } from '../src/routes/packages.js';
import { InMemoryInstalledRegistry } from '../src/plugins/installedRegistry.js';
import { listenLoopback } from './_helpers/listenLoopback.js';
import type { PluginCatalog } from '../src/plugins/manifestLoader.js';
import type {
  UploadedPackage,
  UploadedPackageStore,
} from '../src/plugins/uploadedPackageStore.js';

/**
 * Ingest-path coverage for the scan-scheduler seam (issue #453): the
 * advisory code scan is fire-and-forget and must never affect the ingest
 * result — present, absent, throwing, or rejecting.
 */

const MANIFEST_YAML = `schema_version: "1"

identity:
  id: "@test/scan-target"
  name: "Scan Target"
  version: "1.0.0"
  kind: "tool"
  description: "Fixture plugin for ingest tests."

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

function fixtureZip(): Promise<Buffer> {
  return buildZip({
    'manifest.yaml': MANIFEST_YAML,
    'dist/plugin.js': 'module.exports = { activate() {} };\n',
  });
}

function fakeStore(): UploadedPackageStore {
  const packages = new Map<string, UploadedPackage>();
  return {
    get: (id: string) => packages.get(id),
    list: () => [...packages.values()],
    register: async (pkg: UploadedPackage) => {
      packages.set(pkg.id, pkg);
    },
  } as unknown as UploadedPackageStore;
}

function fakeCatalog(): PluginCatalog {
  return {
    get: () => undefined,
    load: async () => undefined,
    list: () => [],
    // #789 — see the note on the shared helper in _helpers/pluginPackageZip.ts.
    // This fixture's plugin id is `@test/scan-target`, which nothing bundles.
    isBundledId: () => false,
  } as unknown as PluginCatalog;
}

describe('PackageUploadService ingest × scan scheduler (issue #453)', () => {
  let packagesDir: string;

  beforeEach(async () => {
    packagesDir = await fs.mkdtemp(path.join(os.tmpdir(), 'upload-test-'));
  });

  afterEach(async () => {
    await fs.rm(packagesDir, { recursive: true, force: true });
  });

  function service(
    scanScheduler?: ConstructorParameters<typeof PackageUploadService>[0]['scanScheduler'],
  ): PackageUploadService {
    return new PackageUploadService({
      store: fakeStore(),
      catalog: fakeCatalog(),
      packagesDir,
      limits: { maxBytes: 1024 * 1024, maxExtractedBytes: 4 * 1024 * 1024, maxEntries: 50 },
      hostDependencies: {},
      ...(scanScheduler ? { scanScheduler } : {}),
      log: () => undefined,
    });
  }

  it('invokes the scheduler with the ZIP sha256, plugin id, and final dir', async () => {
    const calls: { sha256: string; pluginId: string; installedDir: string }[] = [];
    let resolveScheduled: () => void;
    const scheduled = new Promise<void>((r) => {
      resolveScheduled = r;
    });
    const svc = service({
      scheduleScan: async (input) => {
        calls.push(input);
        resolveScheduled();
      },
    });

    const buffer = await fixtureZip();
    const result = await svc.ingest({
      fileBuffer: buffer,
      originalFilename: 'scan-target.zip',
      uploadedBy: 'test@example.com',
    });

    assert.equal(result.ok, true);
    await scheduled;
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.pluginId, '@test/scan-target');
    assert.equal(
      calls[0]!.sha256,
      createHash('sha256').update(buffer).digest('hex'),
    );
    assert.ok(calls[0]!.installedDir.startsWith(packagesDir));
    // The scheduler receives the post-move location, and the package is
    // actually there (scan runs against the final dir, not staging).
    await fs.access(path.join(calls[0]!.installedDir, 'manifest.yaml'));
  });

  it('ingest succeeds without a scheduler (dep is optional)', async () => {
    const result = await service().ingest({
      fileBuffer: await fixtureZip(),
      originalFilename: 'scan-target.zip',
      uploadedBy: 'test@example.com',
    });
    assert.equal(result.ok, true);
  });

  it('ingest succeeds when the scheduler throws synchronously', async () => {
    const svc = service({
      scheduleScan: () => {
        throw new Error('scheduler exploded');
      },
    });
    const result = await svc.ingest({
      fileBuffer: await fixtureZip(),
      originalFilename: 'scan-target.zip',
      uploadedBy: 'test@example.com',
    });
    assert.equal(result.ok, true);
  });

  it('ingest succeeds when the scheduler rejects asynchronously', async () => {
    const svc = service({
      scheduleScan: async () => {
        throw new Error('async scheduler failure');
      },
    });
    const result = await svc.ingest({
      fileBuffer: await fixtureZip(),
      originalFilename: 'scan-target.zip',
      uploadedBy: 'test@example.com',
    });
    assert.equal(result.ok, true);
  });

  // #453 codex review fix — the scanner skips node_modules, so an entry
  // point there would execute code the scan never saw while the store shows
  // a clean badge. Such packages are rejected at upload time.
  function manifestWithEntry(entry: string): string {
    return MANIFEST_YAML.replace('entry: "dist/plugin.js"', `entry: "${entry}"`);
  }

  it('rejects a lifecycle.entry inside node_modules (scanner blind spot)', async () => {
    const buffer = await buildZip({
      'manifest.yaml': manifestWithEntry('node_modules/payload/plugin.js'),
      'node_modules/payload/plugin.js': 'module.exports = { activate() {} };\n',
      'dist/plugin.js': '// decoy at the boilerplate location\n',
    });
    const result = await service().ingest({
      fileBuffer: buffer,
      originalFilename: 'scan-target.zip',
      uploadedBy: 'test@example.com',
    });
    assert.equal(result.ok, false);
    assert.equal((result as { code: string }).code, 'package.entry_unscannable');
  });

  it('rejects a lifecycle.entry inside a hidden directory', async () => {
    const buffer = await buildZip({
      'manifest.yaml': manifestWithEntry('.hidden/plugin.js'),
      '.hidden/plugin.js': 'module.exports = { activate() {} };\n',
    });
    const result = await service().ingest({
      fileBuffer: buffer,
      originalFilename: 'scan-target.zip',
      uploadedBy: 'test@example.com',
    });
    assert.equal(result.ok, false);
    assert.equal((result as { code: string }).code, 'package.entry_unscannable');
  });

  it('still accepts the boilerplate dist/plugin.js entry', async () => {
    const result = await service().ingest({
      fileBuffer: await fixtureZip(),
      originalFilename: 'scan-target.zip',
      uploadedBy: 'test@example.com',
    });
    assert.equal(result.ok, true);
  });

  // #1401 — the rejection text is German (no request locale); `params` lets
  // the web UI render the code in the operator's locale instead.
  it('sends params with a duplicate-version rejection', async () => {
    const svc = service();
    const upload = async (): Promise<unknown> =>
      svc.ingest({
        fileBuffer: await fixtureZip(),
        originalFilename: 'scan-target.zip',
        uploadedBy: 'test@example.com',
      });
    assert.equal((await upload() as { ok: boolean }).ok, true);
    const second = (await upload()) as { ok: boolean; code: string; params?: unknown };
    assert.equal(second.ok, false);
    assert.equal(second.code, 'package.duplicate_version');
    assert.deepEqual(second.params, { pluginId: '@test/scan-target', version: '1.0.0' });
  });

  it('sends the missing entry path as a param', async () => {
    const buffer = await buildZip({ 'manifest.yaml': manifestWithEntry('dist/missing.js') });
    const result = (await service().ingest({
      fileBuffer: buffer,
      originalFilename: 'scan-target.zip',
      uploadedBy: 'test@example.com',
    })) as { code: string; params?: unknown };
    assert.equal(result.code, 'package.entry_missing');
    assert.deepEqual(result.params, { entry: 'dist/missing.js' });
  });

  it('sends the size limit as a param', async () => {
    const result = (await service().ingest({
      fileBuffer: Buffer.alloc(1024 * 1024 + 1),
      originalFilename: 'big.zip',
      uploadedBy: 'test@example.com',
    })) as { code: string; params?: unknown };
    assert.equal(result.code, 'package.too_large');
    assert.deepEqual(result.params, { maxBytes: String(1024 * 1024) });
  });
});

/**
 * #1455 — version direction. `ingest` used to have exactly one version check
 * (equality → `package.duplicate_version`), so an OLDER version of a plugin
 * that was already installed took the upgrade path: migration ran, the running
 * instance was swapped, and the replaced package folder was deleted. These
 * tests pin the guard, the explicit opt-in, and the retired copy that makes a
 * failed swap recoverable.
 */
describe('PackageUploadService ingest × version direction (issue #1455)', () => {
  let packagesDir: string;

  beforeEach(async () => {
    packagesDir = await fs.mkdtemp(path.join(os.tmpdir(), 'downgrade-test-'));
  });

  afterEach(async () => {
    await fs.rm(packagesDir, { recursive: true, force: true });
  });

  /** Lay down `<packagesDir>/<id>/<version>/` the way a prior ingest would
   *  have, and return the store record that points at it. */
  async function seedInstalled(
    id: string,
    version: string,
  ): Promise<UploadedPackage> {
    const dir = path.join(packagesDir, id, version);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, 'manifest.yaml'),
      MANIFEST_YAML.replace('version: "1.0.0"', `version: "${version}"`),
      'utf-8',
    );
    return {
      id,
      version,
      path: dir,
      uploaded_at: '2026-10-01T00:00:00.000Z',
      uploaded_by: 'seed@example.com',
      sha256: 'a'.repeat(64),
      peers_missing: [],
      zip_bytes: 1,
      extracted_bytes: 1,
      file_count: 1,
    };
  }

  function seededStore(seed: UploadedPackage): {
    store: UploadedPackageStore;
    packages: Map<string, UploadedPackage>;
  } {
    const packages = new Map<string, UploadedPackage>([[seed.id, seed]]);
    const store = {
      get: (id: string) => packages.get(id),
      has: (id: string) => packages.has(id),
      list: () => [...packages.values()],
      register: async (pkg: UploadedPackage) => {
        packages.set(pkg.id, pkg);
      },
    } as unknown as UploadedPackageStore;
    return { store, packages };
  }

  it('refuses an older version by default and leaves the installed one alone', async () => {
    const seed = await seedInstalled('@test/scan-target', '2.0.0');
    const { store, packages } = seededStore(seed);
    // A plugin that is installed AND running is the case from the report.
    const registry = new InMemoryInstalledRegistry();
    await registry.register({
      id: '@test/scan-target',
      installed_version: '2.0.0',
      installed_at: '2026-10-01T00:00:00.000Z',
      status: 'active',
      config: { tenant: 'acme' },
    });
    let activations = 0;
    const svc = new PackageUploadService({
      store,
      catalog: fakeCatalog(),
      packagesDir,
      limits: { maxBytes: 1024 * 1024, maxExtractedBytes: 4 * 1024 * 1024, maxEntries: 50 },
      hostDependencies: {},
      registry,
      onPackageReady: async () => {
        activations += 1;
      },
      log: () => undefined,
    });

    const result = (await svc.ingest({
      fileBuffer: await fixtureZip(),
      originalFilename: 'scan-target-1.0.0.zip',
      uploadedBy: 'operator@example.com',
    })) as { ok: boolean; code: string; params?: unknown };

    assert.equal(result.ok, false);
    assert.equal(result.code, 'package.downgrade_blocked');
    assert.deepEqual(result.params, {
      pluginId: '@test/scan-target',
      fromVersion: '2.0.0',
      toVersion: '1.0.0',
    });

    // Refusal is total: the installed version stays in the store index and on
    // disk, and the older version never lands.
    assert.equal(packages.get('@test/scan-target')?.version, '2.0.0');
    await fs.access(path.join(seed.path, 'manifest.yaml'));
    await assert.rejects(
      fs.access(path.join(packagesDir, '@test/scan-target', '1.0.0')),
    );
    // The installed registry keeps its version and config, and the running
    // instance was never touched: no migration, no deactivate/activate cycle.
    const entry = registry.get('@test/scan-target');
    assert.equal(entry?.installed_version, '2.0.0');
    assert.deepEqual(entry?.config, { tenant: 'acme' });
    assert.equal(activations, 0);
  });

  it('installs the older version with allowDowngrade, and names the direction', async () => {
    const seed = await seedInstalled('@test/scan-target', '2.0.0');
    const { store, packages } = seededStore(seed);
    const logs: string[] = [];
    const svc = new PackageUploadService({
      store,
      catalog: fakeCatalog(),
      packagesDir,
      limits: { maxBytes: 1024 * 1024, maxExtractedBytes: 4 * 1024 * 1024, maxEntries: 50 },
      hostDependencies: {},
      log: (m) => logs.push(m),
    });

    const result = (await svc.ingest({
      fileBuffer: await fixtureZip(),
      originalFilename: 'scan-target-1.0.0.zip',
      uploadedBy: 'operator@example.com',
      allowDowngrade: true,
    })) as { ok: boolean; version: string; direction?: string };

    assert.equal(result.ok, true);
    assert.equal(result.version, '1.0.0');
    assert.equal(result.direction, 'downgrade');
    assert.equal(packages.get('@test/scan-target')?.version, '1.0.0');
    // The log line is the only trace an operator reading journald gets, and
    // before #1455 it read exactly like an upgrade.
    const ingestLine = logs.find((l) => l.startsWith('[upload] ingest OK'));
    assert.ok(ingestLine, `no ingest log line in ${JSON.stringify(logs)}`);
    assert.match(ingestLine, /\[downgrade\]/);
  });

  it('treats a prerelease predecessor as an upgrade, and its reverse as a downgrade', async () => {
    const svc = (store: UploadedPackageStore): PackageUploadService =>
      new PackageUploadService({
        store,
        catalog: fakeCatalog(),
        packagesDir,
        limits: { maxBytes: 1024 * 1024, maxExtractedBytes: 4 * 1024 * 1024, maxEntries: 50 },
        hostDependencies: {},
        log: () => undefined,
      });

    // 1.0.0-rc.1 → 1.0.0 is an upgrade (semver §11: a final release outranks
    // its own prereleases), so it must not be refused.
    const pre = await seedInstalled('@test/scan-target', '1.0.0-rc.1');
    const forward = (await svc(seededStore(pre).store).ingest({
      fileBuffer: await fixtureZip(),
      originalFilename: 'scan-target-1.0.0.zip',
      uploadedBy: 'operator@example.com',
    })) as { ok: boolean; direction?: string };
    assert.equal(forward.ok, true);
    assert.equal(forward.direction, 'upgrade');

    // The reverse is a downgrade: 1.0.0 installed, 1.0.0-rc.1 offered.
    const final = await seedInstalled('@test/scan-target', '1.0.0');
    const rcZip = await buildZip({
      'manifest.yaml': MANIFEST_YAML.replace('version: "1.0.0"', 'version: "1.0.0-rc.1"'),
      'dist/plugin.js': 'module.exports = { activate() {} };\n',
    });
    const backward = (await svc(seededStore(final).store).ingest({
      fileBuffer: rcZip,
      originalFilename: 'scan-target-1.0.0-rc.1.zip',
      uploadedBy: 'operator@example.com',
    })) as { ok: boolean; code?: string };
    assert.equal(backward.ok, false);
    assert.equal(backward.code, 'package.downgrade_blocked');
  });

  it('keeps the replaced package readable while the new version activates', async () => {
    const seed = await seedInstalled('@test/scan-target', '0.9.0');
    const { store } = seededStore(seed);
    const seenDuringActivation: string[] = [];
    const svc = new PackageUploadService({
      store,
      catalog: fakeCatalog(),
      packagesDir,
      limits: { maxBytes: 1024 * 1024, maxExtractedBytes: 4 * 1024 * 1024, maxEntries: 50 },
      hostDependencies: {},
      log: () => undefined,
      // The hook is where the running instance is swapped. Whatever the
      // replaced version left on disk has to still be there at this point —
      // before #1455 it was deleted several steps earlier.
      onPackageReady: async () => {
        const dir = path.join(packagesDir, '@test/scan-target');
        seenDuringActivation.push(
          ...(await fs.readdir(dir)).filter((e) => e.startsWith('.retired-')),
        );
      },
    });

    const result = await svc.ingest({
      fileBuffer: await fixtureZip(),
      originalFilename: 'scan-target-1.0.0.zip',
      uploadedBy: 'operator@example.com',
    });

    assert.equal(result.ok, true);
    assert.deepEqual(seenDuringActivation, ['.retired-0.9.0']);
    // Activation succeeded, so the retired copy is no longer needed.
    const left = await fs.readdir(path.join(packagesDir, '@test/scan-target'));
    assert.deepEqual(left.sort(), ['1.0.0']);
  });

  it('leaves the retired copy on disk when activation fails, and keeps only one', async () => {
    const seed = await seedInstalled('@test/scan-target', '0.9.0');
    const { store } = seededStore(seed);
    const logs: string[] = [];
    const svc = new PackageUploadService({
      store,
      catalog: fakeCatalog(),
      packagesDir,
      limits: { maxBytes: 1024 * 1024, maxExtractedBytes: 4 * 1024 * 1024, maxEntries: 50 },
      hostDependencies: {},
      log: (m) => logs.push(m),
      // #1452 — this throw is swallowed by design today; #1455 only has to
      // make sure it does not also cost the operator the way back.
      onPackageReady: async () => {
        throw new Error('activate() blew up');
      },
    });

    const first = await svc.ingest({
      fileBuffer: await fixtureZip(),
      originalFilename: 'scan-target-1.0.0.zip',
      uploadedBy: 'operator@example.com',
    });
    assert.equal(first.ok, true);

    const pluginDir = path.join(packagesDir, '@test/scan-target');
    assert.deepEqual((await fs.readdir(pluginDir)).sort(), ['.retired-0.9.0', '1.0.0']);
    // The retired package is intact, not an empty husk.
    await fs.access(path.join(pluginDir, '.retired-0.9.0', 'manifest.yaml'));
    assert.ok(
      logs.some((l) => l.includes('.retired-0.9.0')),
      `no log line pointing at the retired copy in ${JSON.stringify(logs)}`,
    );

    // A second swap (1.0.0 → 1.1.0) retires 1.0.0 and must not accumulate:
    // one retired copy per plugin, the newest.
    const next = await buildZip({
      'manifest.yaml': MANIFEST_YAML.replace('version: "1.0.0"', 'version: "1.1.0"'),
      'dist/plugin.js': 'module.exports = { activate() {} };\n',
    });
    const second = await svc.ingest({
      fileBuffer: next,
      originalFilename: 'scan-target-1.1.0.zip',
      uploadedBy: 'operator@example.com',
    });
    assert.equal(second.ok, true);
    assert.deepEqual((await fs.readdir(pluginDir)).sort(), ['.retired-1.0.0', '1.1.0']);
  });

  // The ZIP upload is the only way to reach the downgrade path from the UI,
  // so the refusal has to arrive as a client error with its params, not as a
  // 400 the operator cannot act on.
  it('answers the upload route with 409 + params, and honours the allow_downgrade field', async () => {
    const seed = await seedInstalled('@test/scan-target', '2.0.0');
    const { store, packages } = seededStore(seed);
    const app = express();
    app.use(
      '/packages',
      createPackagesRouter({
        service: new PackageUploadService({
          store,
          catalog: fakeCatalog(),
          packagesDir,
          limits: { maxBytes: 1024 * 1024, maxExtractedBytes: 4 * 1024 * 1024, maxEntries: 50 },
          hostDependencies: {},
          log: () => undefined,
        }),
        store,
        registry: new InMemoryInstalledRegistry(),
        catalog: fakeCatalog(),
        maxBytes: 1024 * 1024,
      }),
    );
    const server = await listenLoopback(app);
    const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/packages/upload`;

    const post = async (consent?: string): Promise<Response> => {
      const form = new FormData();
      const zip = new Uint8Array(await fixtureZip());
      form.append('file', new Blob([zip], { type: 'application/zip' }), 'scan-target.zip');
      if (consent !== undefined) form.append('allow_downgrade', consent);
      return fetch(base, { method: 'POST', body: form });
    };

    try {
      const refused = await post();
      assert.equal(refused.status, 409);
      const body = (await refused.json()) as { code?: string; params?: unknown };
      assert.equal(body.code, 'package.downgrade_blocked');
      assert.deepEqual(body.params, {
        pluginId: '@test/scan-target',
        fromVersion: '2.0.0',
        toVersion: '1.0.0',
      });
      assert.equal(packages.get('@test/scan-target')?.version, '2.0.0');

      const confirmed = await post('true');
      assert.equal(confirmed.status, 201);
      assert.equal(packages.get('@test/scan-target')?.version, '1.0.0');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
