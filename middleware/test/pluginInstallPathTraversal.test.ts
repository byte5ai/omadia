/**
 * Path-traversal containment for the plugin install pipeline.
 *
 * `identity.id` and `identity.version` from an UPLOADED manifest become path
 * segments: the ingest flow installs into `<packagesDir>/<id>/<version>` and
 * `fs.rm -rf`s that directory before renaming the staged package onto it. An
 * id of `..` with version `migrations` therefore used to resolve to a sibling
 * of the packages root and delete it. Reachable without operator interaction
 * via the remote registry install and via vendored plugins in an imported
 * profile bundle.
 *
 * Two layers are asserted here, independently:
 *   1. `adaptManifestV1` rejects an id/version outside the documented charset;
 *   2. `resolveContainedPackageDir` re-proves containment inside the upload
 *      service, immediately before the destructive `fs.rm`.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import yazl from 'yazl';

import { adaptManifestV1 } from '../src/plugins/manifestLoader.js';
import type { PluginCatalog } from '../src/plugins/manifestLoader.js';
import {
  PackageUploadService,
  resolveContainedPackageDir,
} from '../src/plugins/packageUploadService.js';
import type {
  UploadedPackage,
  UploadedPackageStore,
} from '../src/plugins/uploadedPackageStore.js';

// ---------------------------------------------------------------------------
// Layer 1 — manifest loader charset gate
// ---------------------------------------------------------------------------

function manifestDoc(id: string, version: string): Record<string, unknown> {
  return {
    schema_version: '1',
    identity: {
      id,
      kind: 'tool',
      domain: 'test',
      name: 'Traversal Fixture',
      version,
    },
  };
}

describe('adaptManifestV1 identity charset gate', () => {
  const traversingIds = [
    '..',
    '.',
    'a/../..',
    '../../etc',
    '/etc/passwd',
    'plugin/../../../etc',
    '%2e%2e',
    '%2e%2e%2fmigrations',
    'a\\..\\..',
    '..\\..\\migrations',
    // NUL-byte truncation: some fs layers stop at the NUL, so this must
    // not slip through as the harmless `plugin` it prints as.
    'plugin\u0000/x',
    'plugin name with spaces',
    'BadId',
    '@omadia/../evil',
    '@../evil',
    'a/b',
  ];

  for (const id of traversingIds) {
    it(`rejects identity.id ${JSON.stringify(id)}`, () => {
      assert.equal(adaptManifestV1(manifestDoc(id, '1.0.0')), null);
    });
  }

  const traversingVersions = [
    '..',
    'migrations',
    '1.0.0/../../etc',
    '../1.0.0',
    '/etc',
    '%2e%2e',
    '1.0.0\\..\\..',
    'v1.0.0',
    '1.0',
  ];

  for (const version of traversingVersions) {
    it(`rejects identity.version ${JSON.stringify(version)}`, () => {
      assert.equal(adaptManifestV1(manifestDoc('@test/plugin', version)), null);
    });
  }

  it('rejects an id longer than the npm 214-char cap', () => {
    const long = `@omadia/${'a'.repeat(220)}`;
    assert.equal(adaptManifestV1(manifestDoc(long, '1.0.0')), null);
  });

  const legitimate: Array<[string, string]> = [
    ['@omadia/plugin-office', '0.1.1'],
    ['@omadia/agent-reference-maximum', '1.0.0'],
    ['de.byte5.agent.brainstorm-coach', '2.3.4'],
    ['plugin-web-search', '1.0.0-rc.1'],
    ['@omadia/memory', '1.0.0+build.7'],
  ];

  for (const [id, version] of legitimate) {
    it(`accepts ${id}@${version}`, () => {
      const plugin = adaptManifestV1(manifestDoc(id, version));
      assert.ok(plugin);
      assert.equal(plugin.id, id);
      assert.equal(plugin.version, version);
    });
  }
});

// ---------------------------------------------------------------------------
// Layer 2 — upload-service containment, independent of the loader
// ---------------------------------------------------------------------------

describe('resolveContainedPackageDir', () => {
  const root = path.resolve('/srv/.uploaded-packages');

  it('accepts a scoped id and returns the nested install dir', () => {
    const result = resolveContainedPackageDir(root, '@omadia/plugin-office', '0.1.1');
    assert.equal(result.ok, true);
    assert.equal(
      result.ok && result.dir,
      path.join(root, '@omadia', 'plugin-office', '0.1.1'),
    );
  });

  it('rejects an id that escapes the packages root', () => {
    const result = resolveContainedPackageDir(root, '..', 'migrations');
    assert.equal(result.ok, false);
  });

  it('rejects a version that escapes the packages root', () => {
    const result = resolveContainedPackageDir(root, 'plugin', '../../etc');
    assert.equal(result.ok, false);
  });

  it('rejects the packages root itself', () => {
    const result = resolveContainedPackageDir(root, '.', '.');
    assert.equal(result.ok, false);
  });

  // The host-node_modules symlink and the store index live directly under the
  // packages root — an id equal to either stays inside the root as a string
  // but writes through the symlink into the host's real node_modules.
  it('rejects the reserved node_modules entry', () => {
    const result = resolveContainedPackageDir(root, 'node_modules', '1.0.0');
    assert.equal(result.ok, false);
  });

  it('rejects the reserved index.json entry', () => {
    const result = resolveContainedPackageDir(root, 'index.json', '1.0.0');
    assert.equal(result.ok, false);
  });
});

// ---------------------------------------------------------------------------
// End-to-end — the destructive rm must not be reached for a rejected package
// ---------------------------------------------------------------------------

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

function manifestYaml(id: string, version: string): string {
  return `schema_version: "1"

identity:
  id: ${JSON.stringify(id)}
  name: "Traversal Fixture"
  version: ${JSON.stringify(version)}
  kind: "tool"
  description: "Fixture plugin for traversal tests."

compat:
  core: ">=1.0 <2.0"

lifecycle:
  entry: "dist/plugin.js"
`;
}

function packageZip(id: string, version: string): Promise<Buffer> {
  return buildZip({
    'manifest.yaml': manifestYaml(id, version),
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

describe('PackageUploadService ingest × path traversal', () => {
  let root: string;
  let packagesDir: string;
  let victimDir: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'upload-traversal-'));
    packagesDir = path.join(root, '.uploaded-packages');
    await fs.mkdir(packagesDir, { recursive: true });
    // Stand-in for the real `migrations/` directory that sits next to the
    // packages root in the production image.
    victimDir = path.join(root, 'migrations');
    await fs.mkdir(victimDir, { recursive: true });
    await fs.writeFile(path.join(victimDir, '001_init.sql'), 'SELECT 1;\n');
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  function service(): PackageUploadService {
    return new PackageUploadService({
      store: fakeStore(),
      catalog: fakeCatalog(),
      packagesDir,
      limits: {
        maxBytes: 1024 * 1024,
        maxExtractedBytes: 4 * 1024 * 1024,
        maxEntries: 50,
      },
      hostDependencies: {},
      log: () => undefined,
    });
  }

  it('rejects id ".." + version "migrations" and leaves the sibling directory intact', async () => {
    const result = await service().ingest({
      fileBuffer: await packageZip('..', 'migrations'),
      originalFilename: 'evil.zip',
      uploadedBy: 'attacker@example.com',
    });

    assert.equal(result.ok, false);
    assert.equal((result as { code: string }).code, 'package.manifest_invalid');
    // The destructive `fs.rm(finalDir, {recursive:true})` was never reached.
    const survivors = await fs.readdir(victimDir);
    assert.deepEqual(survivors, ['001_init.sql']);
  });

  for (const id of ['a/../..', '../../etc', '/etc/passwd', '..\\..\\etc']) {
    it(`rejects the traversing id ${JSON.stringify(id)}`, async () => {
      const result = await service().ingest({
        fileBuffer: await packageZip(id, '1.0.0'),
        originalFilename: 'evil.zip',
        uploadedBy: 'attacker@example.com',
      });
      assert.equal(result.ok, false);
      assert.equal((result as { code: string }).code, 'package.manifest_invalid');
      assert.deepEqual(await fs.readdir(victimDir), ['001_init.sql']);
    });
  }

  it('rejects a URL-encoded traversal attempt', async () => {
    const result = await service().ingest({
      fileBuffer: await packageZip('%2e%2e', '1.0.0'),
      originalFilename: 'evil.zip',
      uploadedBy: 'attacker@example.com',
    });
    assert.equal(result.ok, false);
    assert.equal((result as { code: string }).code, 'package.manifest_invalid');
  });

  it('rejects a version that traverses out of the plugin directory', async () => {
    const result = await service().ingest({
      fileBuffer: await packageZip('@test/plugin', '../../migrations'),
      originalFilename: 'evil.zip',
      uploadedBy: 'attacker@example.com',
    });
    assert.equal(result.ok, false);
    assert.equal((result as { code: string }).code, 'package.manifest_invalid');
    assert.deepEqual(await fs.readdir(victimDir), ['001_init.sql']);
  });

  // The loader accepts `node_modules` (a syntactically valid npm name), so
  // this exercises the upload service's own guard end-to-end.
  it('rejects an id colliding with the host node_modules symlink', async () => {
    const result = await service().ingest({
      fileBuffer: await packageZip('node_modules', '1.0.0'),
      originalFilename: 'evil.zip',
      uploadedBy: 'attacker@example.com',
    });
    assert.equal(result.ok, false);
    assert.equal((result as { code: string }).code, 'package.path_traversal');
  });

  it('still installs a legitimate scoped package', async () => {
    const result = await service().ingest({
      fileBuffer: await packageZip('@omadia/plugin-office', '0.1.1'),
      originalFilename: 'plugin-office.zip',
      uploadedBy: 'operator@example.com',
    });

    assert.equal(result.ok, true);
    const finalDir = path.join(packagesDir, '@omadia', 'plugin-office', '0.1.1');
    assert.equal((result as { package: UploadedPackage }).package.path, finalDir);
    await fs.access(path.join(finalDir, 'manifest.yaml'));
  });
});
