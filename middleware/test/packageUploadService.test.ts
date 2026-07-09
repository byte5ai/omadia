import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import yazl from 'yazl';

import { PackageUploadService } from '../src/plugins/packageUploadService.js';
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
});
