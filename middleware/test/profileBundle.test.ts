import { strict as assert } from 'node:assert';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { stringify as stringifyYaml } from 'yaml';
import yazl from 'yazl';

import type { PluginCatalog } from '../src/plugins/manifestLoader.js';
import type { PackageUploadService } from '../src/plugins/packageUploadService.js';
import {
  computeBundleHash,
  sha256Hex,
} from '../src/plugins/profileBundleManifest.js';
import { ProfileBundleImporter } from '../src/plugins/profileBundleImporter.js';
import {
  ProfileBundleZipperError,
  zipProfileBundle,
} from '../src/plugins/profileBundleZipper.js';
import {
  UploadedPackageStore,
  type UploadedPackage,
} from '../src/plugins/uploadedPackageStore.js';

/**
 * Profile-Bundle v1 smoke + acceptance tests.
 *
 * Coverage:
 *   - Roundtrip (Zip → Import without vendoring)
 *   - Hash verification (tampered manifest → reject)
 *   - Whitelist reject (unknown plugin → reject with stable code)
 *   - Vendoring (Bundle with vendored plugin → ingest fires)
 *   - Spec-version mismatch (bundleSpec: 2 → reject)
 *   - Foreign top-level entry (extra file → reject)
 */

const FIXTURE_AGENT_MD = `---
schema_version: 1
identity:
  id: test-bot
  display_name: Test Bot
  description: Fixture profile for bundle round-trip
secrets: [TAVILY_API_KEY]
---

# System Prompt

Antworte knapp.
`;

const TEST_PLUGIN_ID = 'harness-plugin-test-fixture';
const TEST_PLUGIN_VERSION = '1.0.0';
const TEST_PLUGIN_SHA = 'a'.repeat(64);

function makeUploadedPackage(overrides: Partial<UploadedPackage> = {}): UploadedPackage {
  return {
    id: TEST_PLUGIN_ID,
    version: TEST_PLUGIN_VERSION,
    path: '/tmp/fake-plugin-path',
    uploaded_at: '2026-05-07T10:00:00.000Z',
    uploaded_by: 'test@example.com',
    sha256: TEST_PLUGIN_SHA,
    peers_missing: [],
    zip_bytes: 0,
    extracted_bytes: 0,
    file_count: 0,
    ...overrides,
  };
}

function makeCatalogStub(): PluginCatalog {
  return { get: () => undefined } as unknown as PluginCatalog;
}

interface IngestRecord {
  fileBuffer: Buffer;
  originalFilename: string;
  uploadedBy: string;
  sha256?: string;
}

function makeUploadServiceStub(opts: {
  shouldSucceed?: boolean;
  onIngest?: (input: IngestRecord) => void;
} = {}): PackageUploadService {
  const shouldSucceed = opts.shouldSucceed ?? true;
  return {
    ingest: async (input: IngestRecord) => {
      opts.onIngest?.(input);
      if (!shouldSucceed) {
        return {
          ok: false as const,
          code: 'package.test_failure',
          message: 'forced failure for test',
        };
      }
      return {
        ok: true as const,
        package: makeUploadedPackage({ id: input.originalFilename }),
        plugin_id: TEST_PLUGIN_ID,
        version: TEST_PLUGIN_VERSION,
      };
    },
  } as unknown as PackageUploadService;
}

describe('Profile-Bundle v1', () => {
  let tmpRoot: string;
  let store: UploadedPackageStore;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pb-test-'));
    const indexPath = path.join(tmpRoot, 'index.json');
    const pkgDir = path.join(tmpRoot, 'packages');
    store = new UploadedPackageStore(indexPath, pkgDir);
    await store.load();
    await store.register(makeUploadedPackage());
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  });

  it('roundtrip: zip → import preserves content + plugins', async () => {
    const knowledgeContent = Buffer.from('# Style\nKurz.', 'utf8');

    const result = await zipProfileBundle(
      { store },
      {
        profileId: 'test-bot',
        profileName: 'Test Bot',
        profileVersion: '1.0.0',
        createdBy: 'john@example.com',
        agentMd: FIXTURE_AGENT_MD,
        pluginPins: [
          { id: TEST_PLUGIN_ID, version: TEST_PLUGIN_VERSION },
        ],
        knowledge: [{ filename: 'style.md', content: knowledgeContent }],
        createdAt: '2026-05-07T10:00:00.000Z',
      },
    );

    assert.equal(result.manifest.profile.id, 'test-bot');
    assert.equal(result.manifest.plugins.length, 1);
    assert.equal(result.manifest.plugins[0]?.sha256, TEST_PLUGIN_SHA);
    assert.equal(result.manifest.knowledge.length, 1);
    assert.equal(result.manifest.bundle_hash.length, 64);

    const importer = new ProfileBundleImporter({
      uploadedPackageStore: store,
      catalog: makeCatalogStub(),
    });

    let captured: Parameters<Parameters<typeof importer.import>[0]['onPersist']>[0] | undefined;
    const importResult = await importer.import({
      fileBuffer: result.buffer,
      uploadedBy: 'john@example.com',
      onPersist: async (payload) => {
        captured = payload;
      },
    });

    assert.equal(importResult.ok, true);
    if (importResult.ok) {
      assert.equal(importResult.profileId, 'test-bot');
      assert.equal(importResult.pluginsInstalled, 0);
    }
    assert.ok(captured, 'persist callback ran');
    assert.equal(captured?.agentMd.toString('utf8'), FIXTURE_AGENT_MD);
    assert.equal(captured?.plugins.length, 1);
    assert.equal(captured?.knowledge[0]?.filename, 'knowledge/style.md');
    assert.equal(
      captured?.knowledge[0]?.content.toString('utf8'),
      knowledgeContent.toString('utf8'),
    );
  });

  it('rejects bundle when bundle_hash is tampered', async () => {
    const result = await zipProfileBundle(
      { store },
      {
        profileId: 'test-bot',
        profileName: 'Test Bot',
        profileVersion: '1.0.0',
        createdBy: 'john@example.com',
        agentMd: FIXTURE_AGENT_MD,
        pluginPins: [{ id: TEST_PLUGIN_ID, version: TEST_PLUGIN_VERSION }],
        createdAt: '2026-05-07T10:00:00.000Z',
      },
    );

    // Repackage with a manipulated manifest (wrong bundle_hash)
    const tamperedManifest = {
      ...result.manifest,
      bundle_hash: 'b'.repeat(64),
    };
    const tamperedZip = await rebuildZipWithManifest(result.buffer, tamperedManifest);

    const importer = new ProfileBundleImporter({
      uploadedPackageStore: store,
      catalog: makeCatalogStub(),
    });
    const importResult = await importer.import({
      fileBuffer: tamperedZip,
      uploadedBy: 'm@example.com',
      onPersist: async () => {},
    });
    assert.equal(importResult.ok, false);
    if (!importResult.ok) {
      assert.equal(importResult.code, 'bundle.hash_mismatch');
    }
  });

  it('rejects bundle when agent.md content is swapped', async () => {
    const result = await zipProfileBundle(
      { store },
      {
        profileId: 'test-bot',
        profileName: 'Test Bot',
        profileVersion: '1.0.0',
        createdBy: 'john@example.com',
        agentMd: FIXTURE_AGENT_MD,
        pluginPins: [{ id: TEST_PLUGIN_ID, version: TEST_PLUGIN_VERSION }],
        createdAt: '2026-05-07T10:00:00.000Z',
      },
    );
    const tampered = await rebuildZipWithFile(result.buffer, 'agent.md', Buffer.from('# different'));

    const importer = new ProfileBundleImporter({
      uploadedPackageStore: store,
      catalog: makeCatalogStub(),
    });
    const importResult = await importer.import({
      fileBuffer: tampered,
      uploadedBy: 'm@example.com',
      onPersist: async () => {},
    });
    assert.equal(importResult.ok, false);
    if (!importResult.ok) {
      assert.equal(importResult.code, 'bundle.agent_hash_mismatch');
    }
  });

  it('rejects bundle whose pinned plugin is unknown locally', async () => {
    const result = await zipProfileBundle(
      { store },
      {
        profileId: 'test-bot',
        profileName: 'Test Bot',
        profileVersion: '1.0.0',
        createdBy: 'john@example.com',
        agentMd: FIXTURE_AGENT_MD,
        pluginPins: [{ id: TEST_PLUGIN_ID, version: TEST_PLUGIN_VERSION }],
        createdAt: '2026-05-07T10:00:00.000Z',
      },
    );

    // Empty store on the import side
    const emptyDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pb-empty-'));
    const emptyStore = new UploadedPackageStore(
      path.join(emptyDir, 'index.json'),
      path.join(emptyDir, 'packages'),
    );
    await emptyStore.load();

    try {
      const importer = new ProfileBundleImporter({
        uploadedPackageStore: emptyStore,
        catalog: makeCatalogStub(),
      });
      const importResult = await importer.import({
        fileBuffer: result.buffer,
        uploadedBy: 'm@example.com',
        onPersist: async () => {},
      });
      assert.equal(importResult.ok, false);
      if (!importResult.ok) {
        assert.equal(importResult.code, 'bundle.unknown_plugin');
      }
    } finally {
      await fs.rm(emptyDir, { recursive: true, force: true });
    }
  });

  it('vendoring: bundle with vendored plugin triggers ingest on import', async () => {
    // Prepare a fake plugin directory under tmp so the Zipper can vendor it
    const pluginDir = path.join(tmpRoot, 'plugins', `${TEST_PLUGIN_ID}-${TEST_PLUGIN_VERSION}`);
    await fs.mkdir(pluginDir, { recursive: true });
    await fs.writeFile(
      path.join(pluginDir, 'manifest.yaml'),
      stringifyYaml({
        schema_version: '1',
        identity: { id: TEST_PLUGIN_ID, name: 'Fixture', version: TEST_PLUGIN_VERSION },
      }),
      'utf8',
    );

    // Re-register with the directory path so vendoring can find it
    await store.register(makeUploadedPackage({ path: pluginDir }));

    // Vendoring computes the inner-zip sha256 dynamically; we don't know it
    // upfront, so override the pin sha256 to match what the zipper produces.
    // To do this, we run the zipper twice: first with vendoring=false to get
    // the manifest baseline, then with vendoring=true. The Zipper itself
    // recomputes hashes — so we just trust the result.
    const result = await zipProfileBundle(
      { store },
      {
        profileId: 'test-bot',
        profileName: 'Test Bot',
        profileVersion: '1.0.0',
        createdBy: 'john@example.com',
        agentMd: FIXTURE_AGENT_MD,
        // For vendored bundles the Zipper uses the store's sha256; the inner
        // zip is built deterministically from the directory but its sha256
        // isn't pinned at creation time — instead the manifest carries the
        // store's sha256 as the canonical pin. Importer must then verify the
        // vendored zip bytes match that pin. Our store-level sha256 is
        // synthetic ('a'*64), so we adjust the store entry to use the actual
        // hash of what we'll build below.
        pluginPins: [{ id: TEST_PLUGIN_ID, version: TEST_PLUGIN_VERSION }],
        vendorPlugins: true,
        createdAt: '2026-05-07T10:00:00.000Z',
      },
    );

    // The zipper used the store's sha256 in the manifest, but the inner zip's
    // bytes won't match that value. Therefore the importer expects a sha
    // mismatch — which is the correct behaviour: vendored sha256 in the
    // manifest must equal the inner zip's sha256. We re-pack a corrected
    // bundle by computing the inner zip's true sha256 and patching the manifest.
    const corrected = await fixVendoredManifestSha(result.buffer);

    let ingestCalled = false;
    const uploadService = makeUploadServiceStub({
      onIngest: () => {
        ingestCalled = true;
      },
    });

    // Use a fresh empty store to prove ingest wires up
    const freshDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pb-fresh-'));
    const freshStore = new UploadedPackageStore(
      path.join(freshDir, 'index.json'),
      path.join(freshDir, 'packages'),
    );
    await freshStore.load();

    try {
      const importer = new ProfileBundleImporter({
        uploadedPackageStore: freshStore,
        catalog: makeCatalogStub(),
        uploadService,
      });
      const importResult = await importer.import({
        fileBuffer: corrected,
        uploadedBy: 'm@example.com',
        onPersist: async () => {},
      });
      assert.equal(importResult.ok, true, JSON.stringify(importResult));
      if (importResult.ok) {
        assert.equal(importResult.pluginsInstalled, 1);
      }
      assert.equal(ingestCalled, true);
    } finally {
      await fs.rm(freshDir, { recursive: true, force: true });
    }
  });

  it('rejects bundle with bundleSpec !== 1', async () => {
    const result = await zipProfileBundle(
      { store },
      {
        profileId: 'test-bot',
        profileName: 'Test Bot',
        profileVersion: '1.0.0',
        createdBy: 'john@example.com',
        agentMd: FIXTURE_AGENT_MD,
        pluginPins: [{ id: TEST_PLUGIN_ID, version: TEST_PLUGIN_VERSION }],
        createdAt: '2026-05-07T10:00:00.000Z',
      },
    );

    const wrongSpec = await rebuildZipWithRawManifest(
      result.buffer,
      stringifyYaml({ ...result.manifest, harness: { bundleSpec: 2 } }),
    );

    const importer = new ProfileBundleImporter({
      uploadedPackageStore: store,
      catalog: makeCatalogStub(),
    });
    const importResult = await importer.import({
      fileBuffer: wrongSpec,
      uploadedBy: 'm@example.com',
      onPersist: async () => {},
    });
    assert.equal(importResult.ok, false);
    if (!importResult.ok) {
      // Zod literal rejects this at parse time as invalid_manifest.
      // Either is acceptable as long as we hard-reject.
      assert.ok(
        importResult.code === 'bundle.invalid_manifest' ||
          importResult.code === 'bundle.unsupported_spec_version',
        `expected invalid_manifest or unsupported_spec_version, got ${importResult.code}`,
      );
    }
  });

  it('rejects bundle with foreign top-level entry', async () => {
    const result = await zipProfileBundle(
      { store },
      {
        profileId: 'test-bot',
        profileName: 'Test Bot',
        profileVersion: '1.0.0',
        createdBy: 'john@example.com',
        agentMd: FIXTURE_AGENT_MD,
        pluginPins: [{ id: TEST_PLUGIN_ID, version: TEST_PLUGIN_VERSION }],
        createdAt: '2026-05-07T10:00:00.000Z',
      },
    );
    const withForeign = await rebuildZipWithFile(
      result.buffer,
      'README.md',
      Buffer.from('hi'),
    );

    const importer = new ProfileBundleImporter({
      uploadedPackageStore: store,
      catalog: makeCatalogStub(),
    });
    const importResult = await importer.import({
      fileBuffer: withForeign,
      uploadedBy: 'm@example.com',
      onPersist: async () => {},
    });
    assert.equal(importResult.ok, false);
    if (!importResult.ok) {
      assert.equal(importResult.code, 'bundle.foreign_top_level');
    }
  });

  it('inline vendored plugin lands at plugins/<id>-<version>.zip with computed sha256', async () => {
    // OB-83 Builder-snapshot path: BuildPipeline produces a plugin ZIP
    // buffer that the Zipper packs without touching the upload store.
    // The pin's vendored=true flips on automatically, sha256 is computed
    // from the inline bytes.
    const fakePluginZip = Buffer.from('PK\x03\x04 fake-plugin-zip-bytes');
    const inlineMap = new Map<string, Buffer>([
      ['de.byte5.agent.demo@0.1.0', fakePluginZip],
    ]);
    const result = await zipProfileBundle(
      { store },
      {
        profileId: 'demo-bot',
        profileName: 'Demo',
        profileVersion: '1.0.0',
        createdBy: 'op@example.com',
        agentMd: FIXTURE_AGENT_MD,
        pluginPins: [{ id: 'de.byte5.agent.demo', version: '0.1.0' }],
        inlineVendoredPlugins: inlineMap,
        createdAt: '2026-05-08T10:00:00.000Z',
      },
    );
    assert.equal(result.manifest.plugins.length, 1);
    assert.equal(result.manifest.plugins[0]!.vendored, true);
    assert.equal(result.manifest.plugins[0]!.sha256.length, 64);

    // Verify the inner ZIP entry exists and has the expected bytes.
    const yauzlMod = await import('yauzl');
    const entries = await new Promise<Map<string, Buffer>>((resolve, reject) => {
      yauzlMod.default.fromBuffer(result.buffer, { lazyEntries: true }, (err, zf) => {
        if (err || !zf) return reject(err ?? new Error('open failed'));
        const out = new Map<string, Buffer>();
        zf.readEntry();
        zf.on('entry', (entry) => {
          if (/\/$/.test(entry.fileName)) {
            zf.readEntry();
            return;
          }
          zf.openReadStream(entry, (e2, stream) => {
            if (e2 || !stream) return reject(e2 ?? new Error('stream failed'));
            const chunks: Buffer[] = [];
            stream.on('data', (c: Buffer) => chunks.push(c));
            stream.on('end', () => {
              out.set(entry.fileName, Buffer.concat(chunks));
              zf.readEntry();
            });
            stream.on('error', reject);
          });
        });
        zf.on('end', () => resolve(out));
        zf.on('error', reject);
      });
    });
    const inner = entries.get('plugins/de.byte5.agent.demo-0.1.0.zip');
    assert.ok(inner, 'inner plugin zip must be packed at plugins/<id>-<version>.zip');
    assert.equal(inner!.toString('utf8'), fakePluginZip.toString('utf8'));
  });

  it('synthesises a deterministic sha256 for built-in plugins not in the store', async () => {
    // No vendoring + plugin not in store + no caller-supplied sha256 →
    // built-in plugin path. Should NOT throw; the manifest gets a stable
    // synthetic hash that the Importer's catalog-trust branch accepts.
    const result = await zipProfileBundle(
      { store },
      {
        profileId: 'test-bot',
        profileName: 'Test Bot',
        profileVersion: '1.0.0',
        createdBy: 'john@example.com',
        agentMd: FIXTURE_AGENT_MD,
        pluginPins: [{ id: 'de.byte5.builtin.example', version: '0.1.0' }],
        createdAt: '2026-05-07T10:00:00.000Z',
      },
    );
    assert.equal(result.manifest.plugins.length, 1);
    assert.equal(result.manifest.plugins[0]!.id, 'de.byte5.builtin.example');
    assert.equal(result.manifest.plugins[0]!.sha256.length, 64);
    // Determinism: re-zipping the same built-in pin yields the same hash.
    const result2 = await zipProfileBundle(
      { store },
      {
        profileId: 'test-bot',
        profileName: 'Test Bot',
        profileVersion: '1.0.0',
        createdBy: 'john@example.com',
        agentMd: FIXTURE_AGENT_MD,
        pluginPins: [{ id: 'de.byte5.builtin.example', version: '0.1.0' }],
        createdAt: '2026-05-07T10:00:00.000Z',
      },
    );
    assert.equal(
      result.manifest.plugins[0]!.sha256,
      result2.manifest.plugins[0]!.sha256,
    );
  });

  it('computeBundleHash is deterministic regardless of plugin order', () => {
    const a = computeBundleHash('p', '1.0.0', {
      agentSha256: 'a'.repeat(64),
      plugins: [
        { id: 'plug-b', version: '1.0.0', sha256: 'b'.repeat(64) },
        { id: 'plug-a', version: '1.0.0', sha256: 'c'.repeat(64) },
      ],
      knowledge: [],
    });
    const b = computeBundleHash('p', '1.0.0', {
      agentSha256: 'a'.repeat(64),
      plugins: [
        { id: 'plug-a', version: '1.0.0', sha256: 'c'.repeat(64) },
        { id: 'plug-b', version: '1.0.0', sha256: 'b'.repeat(64) },
      ],
      knowledge: [],
    });
    assert.equal(a, b);
  });

  it('vendoring is best-effort — built-in plugins fall back to pin-only without throwing', async () => {
    // Empty store + vendorPlugins: true + built-in plugin pin (no sha256
    // supplied). Pre-fix this threw bundle.plugin_zip_missing; post-fix
    // the plugin lands in the manifest with vendored=false (pin-only).
    const emptyDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pb-zip-'));
    const emptyStore = new UploadedPackageStore(
      path.join(emptyDir, 'index.json'),
      path.join(emptyDir, 'packages'),
    );
    await emptyStore.load();
    try {
      const result = await zipProfileBundle(
        { store: emptyStore },
        {
          profileId: 'test-bot',
          profileName: 'Test Bot',
          profileVersion: '1.0.0',
          createdBy: 'john@example.com',
          agentMd: FIXTURE_AGENT_MD,
          pluginPins: [{ id: 'de.byte5.builtin.calendar', version: '0.1.0' }],
          vendorPlugins: true,
          createdAt: '2026-05-07T10:00:00.000Z',
        },
      );
      assert.equal(result.manifest.plugins.length, 1);
      assert.equal(result.manifest.plugins[0]!.vendored, false);
      assert.equal(result.manifest.plugins[0]!.id, 'de.byte5.builtin.calendar');
    } finally {
      await fs.rm(emptyDir, { recursive: true, force: true });
    }
  });

  it('vendoring still hard-rejects when caller supplies a wrong sha256', async () => {
    // sha256 mismatch between input and store is still a hard error —
    // that's a manifest-integrity concern, not a "can we pack it" one.
    const localTmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pb-mismatch-'));
    const localStore = new UploadedPackageStore(
      path.join(localTmp, 'idx.json'),
      path.join(localTmp, 'pkgs'),
    );
    await localStore.load();
    await localStore.register({
      id: TEST_PLUGIN_ID,
      version: TEST_PLUGIN_VERSION,
      path: '/tmp/whatever',
      uploaded_at: '2026-05-07T00:00:00.000Z',
      uploaded_by: 'op@example.com',
      sha256: TEST_PLUGIN_SHA,
      peers_missing: [],
      zip_bytes: 0,
      extracted_bytes: 0,
      file_count: 0,
    });
    try {
      await assert.rejects(
        () =>
          zipProfileBundle(
            { store: localStore },
            {
              profileId: 'test-bot',
              profileName: 'Test Bot',
              profileVersion: '1.0.0',
              createdBy: 'john@example.com',
              agentMd: FIXTURE_AGENT_MD,
              pluginPins: [
                { id: TEST_PLUGIN_ID, version: TEST_PLUGIN_VERSION, sha256: 'b'.repeat(64) },
              ],
              createdAt: '2026-05-07T10:00:00.000Z',
            },
          ),
        (err) =>
          err instanceof ProfileBundleZipperError &&
          err.code === 'bundle.unknown_plugin',
      );
    } finally {
      await fs.rm(localTmp, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Test helpers — manipulate ZIP contents
// ---------------------------------------------------------------------------

async function unzipToMap(buf: Buffer): Promise<Map<string, Buffer>> {
  const yauzl = await import('yauzl');
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buf, { lazyEntries: true }, (err, zf) => {
      if (err || !zf) return reject(err ?? new Error('cannot open buffer'));
      const out = new Map<string, Buffer>();
      zf.readEntry();
      zf.on('entry', (entry) => {
        if (/\/$/.test(entry.fileName)) {
          zf.readEntry();
          return;
        }
        zf.openReadStream(entry, (e2, stream) => {
          if (e2 || !stream) return reject(e2 ?? new Error('no stream'));
          const chunks: Buffer[] = [];
          stream.on('data', (c: Buffer) => chunks.push(c));
          stream.on('end', () => {
            out.set(entry.fileName, Buffer.concat(chunks));
            zf.readEntry();
          });
          stream.on('error', reject);
        });
      });
      zf.on('end', () => resolve(out));
      zf.on('error', reject);
    });
  });
}

async function zipFromMap(map: Map<string, Buffer>): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    const chunks: Buffer[] = [];
    zip.outputStream.on('data', (c: Buffer) => chunks.push(c));
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    zip.outputStream.on('error', reject);
    const mtime = new Date(0);
    for (const [name, content] of map) {
      zip.addBuffer(content, name, { mtime });
    }
    zip.end();
  });
}

async function rebuildZipWithManifest(
  buf: Buffer,
  manifest: object,
): Promise<Buffer> {
  const map = await unzipToMap(buf);
  map.set('profile-manifest.yaml', Buffer.from(stringifyYaml(manifest), 'utf8'));
  return zipFromMap(map);
}

async function rebuildZipWithRawManifest(
  buf: Buffer,
  manifestYaml: string,
): Promise<Buffer> {
  const map = await unzipToMap(buf);
  map.set('profile-manifest.yaml', Buffer.from(manifestYaml, 'utf8'));
  return zipFromMap(map);
}

async function rebuildZipWithFile(
  buf: Buffer,
  filename: string,
  content: Buffer,
): Promise<Buffer> {
  const map = await unzipToMap(buf);
  map.set(filename, content);
  return zipFromMap(map);
}

/**
 * For vendored bundles the manifest's `plugins[].sha256` must match the
 * inner zip's bytes — but the Zipper uses the UploadedPackageStore's sha256
 * (which is synthetic in tests). This helper recomputes the inner-zip sha256
 * and patches the manifest + bundle_hash so the importer accepts it.
 */
async function fixVendoredManifestSha(buf: Buffer): Promise<Buffer> {
  const map = await unzipToMap(buf);
  const manifestRaw = map.get('profile-manifest.yaml');
  if (!manifestRaw) throw new Error('test helper: manifest missing');
  const { parse: parseYaml } = await import('yaml');
  const manifest = parseYaml(manifestRaw.toString('utf8')) as Record<string, unknown>;
  const plugins = manifest['plugins'] as Array<Record<string, unknown>>;
  for (const p of plugins) {
    if (p['vendored'] === true) {
      const innerName = `plugins/${String(p['id'])}-${String(p['version'])}.zip`;
      const inner = map.get(innerName);
      if (!inner) throw new Error(`test helper: inner zip missing ${innerName}`);
      p['sha256'] = sha256Hex(inner);
    }
  }
  // Recompute bundle_hash
  manifest['bundle_hash'] = computeBundleHash(
    (manifest['profile'] as Record<string, string>)['id'] as string,
    (manifest['profile'] as Record<string, string>)['version'] as string,
    {
      agentSha256: (manifest['agent'] as Record<string, string>)['sha256'] as string,
      plugins: plugins.map((p) => ({
        id: p['id'] as string,
        version: p['version'] as string,
        sha256: p['sha256'] as string,
      })),
      knowledge:
        (manifest['knowledge'] as Array<{ file: string; sha256: string }>) ?? [],
    },
  );
  const { stringify: stringifyYaml2 } = await import('yaml');
  map.set('profile-manifest.yaml', Buffer.from(stringifyYaml2(manifest), 'utf8'));
  return zipFromMap(map);
}
