import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { BuiltInPackageStore } from '../src/plugins/builtInPackageStore.js';
import { LocalDevPackageStore } from '../src/plugins/localDevPackageStore.js';
import { PluginCatalog } from '../src/plugins/manifestLoader.js';
import { UploadedPackageStore } from '../src/plugins/uploadedPackageStore.js';

function writeManifest(
  packageRoot: string,
  id: string,
  version: string,
): void {
  mkdirSync(packageRoot, { recursive: true });
  const lines = [
    'schema_version: "1"',
    'identity:',
    `  id: ${id}`,
    `  name: ${id.split('.').pop() ?? id}`,
    `  version: ${version}`,
    '  kind: agent',
    'lifecycle:',
    '  entry: dist/plugin.js',
  ];
  writeFileSync(join(packageRoot, 'manifest.yaml'), lines.join('\n') + '\n');
}

describe('LocalDevPackageStore', () => {
  it('is disabled when PLUGIN_DEV_DIR is undefined', async () => {
    const store = new LocalDevPackageStore(undefined);
    await store.load();
    assert.equal(store.enabled(), false);
    assert.equal(store.rootPath(), undefined);
    assert.deepEqual(store.list(), []);
  });

  it('is disabled for empty / whitespace-only PLUGIN_DEV_DIR', async () => {
    const empty = new LocalDevPackageStore('');
    await empty.load();
    assert.equal(empty.enabled(), false);

    const whitespace = new LocalDevPackageStore('   ');
    await whitespace.load();
    assert.equal(whitespace.enabled(), false);
  });

  it('picks up dev packages with valid manifests and skips bare folders', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'localdev-store-test-'));
    try {
      writeManifest(join(dir, 'agent-alpha'), 'test.agent.alpha', '0.1.0');
      writeManifest(join(dir, 'agent-beta'), 'test.agent.beta', '2.0.0');
      mkdirSync(join(dir, 'no-manifest', 'src'), { recursive: true });
      writeFileSync(join(dir, 'no-manifest', 'package.json'), '{}');

      const store = new LocalDevPackageStore(dir);
      await store.load();

      assert.equal(store.enabled(), true);
      const ids = store.list().map((p) => p.id);
      assert.deepEqual(ids, ['test.agent.alpha', 'test.agent.beta']);
      assert.equal(store.get('test.agent.alpha')?.version, '0.1.0');
      assert.ok(store.has('test.agent.beta'));
      assert.ok(!store.has('no-manifest'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('tolerates a missing PLUGIN_DEV_DIR (configured but not on disk)', async () => {
    const store = new LocalDevPackageStore('/nonexistent/path/abc-localdev-test');
    await store.load();
    assert.equal(store.enabled(), true);
    assert.equal(store.list().length, 0);
  });

  it('skips an invalid manifest with a warning, does not crash boot', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'localdev-store-bad-'));
    try {
      mkdirSync(join(dir, 'broken'), { recursive: true });
      writeFileSync(join(dir, 'broken', 'manifest.yaml'), 'not-a-real-schema: true\n');
      writeManifest(join(dir, 'good'), 'test.agent.good', '1.0.0');

      const store = new LocalDevPackageStore(dir);
      await store.load();
      const ids = store.list().map((p) => p.id);
      assert.deepEqual(ids, ['test.agent.good']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('PluginCatalog: resolution order Local-Dev > Uploaded > Built-in', () => {
  it('local-dev wins on ID collision over uploaded and built-in', async () => {
    const builtInDir = mkdtempSync(join(tmpdir(), 'order-builtin-'));
    const uploadedDir = mkdtempSync(join(tmpdir(), 'order-uploaded-'));
    const localDevDir = mkdtempSync(join(tmpdir(), 'order-localdev-'));
    try {
      // Same ID, different versions in each source.
      writeManifest(join(builtInDir, 'shared'), 'test.agent.shared', '1.0.0');
      writeManifest(join(uploadedDir, 'shared'), 'test.agent.shared', '2.0.0');
      writeManifest(join(localDevDir, 'shared'), 'test.agent.shared', '3.0.0');

      const builtInStore = new BuiltInPackageStore(builtInDir);
      await builtInStore.load();
      const uploadedStore = new UploadedPackageStore(
        join(uploadedDir, 'index.json'),
        uploadedDir,
      );
      await uploadedStore.load();
      // UploadedPackageStore is index.json-driven; we register the shared
      // package manually so the resolution-order test does not depend on the
      // upload pipeline.
      await uploadedStore.register({
        id: 'test.agent.shared',
        version: '2.0.0',
        path: join(uploadedDir, 'shared'),
        uploaded_at: new Date().toISOString(),
        uploaded_by: 'test',
        sha256: 'x'.repeat(64),
        peers_missing: [],
        zip_bytes: 0,
        extracted_bytes: 0,
        file_count: 0,
      });
      const localDevStore = new LocalDevPackageStore(localDevDir);
      await localDevStore.load();

      const catalog = new PluginCatalog({
        manifestDir: '/nonexistent',
        extraSources: () => [
          ...builtInStore.list().map((p) => ({ packageRoot: p.path })),
          ...uploadedStore.list().map((p) => ({ packageRoot: p.path })),
          ...localDevStore.list().map((p) => ({ packageRoot: p.path })),
        ],
      });
      await catalog.load();

      const winner = catalog.get('test.agent.shared');
      assert.ok(winner, 'expected catalog to contain shared id');
      assert.equal(
        winner.plugin.version,
        '3.0.0',
        'Local-Dev must win over Uploaded and Built-in',
      );
    } finally {
      rmSync(builtInDir, { recursive: true, force: true });
      rmSync(uploadedDir, { recursive: true, force: true });
      rmSync(localDevDir, { recursive: true, force: true });
    }
  });

  it('uploaded wins over built-in when local-dev is empty', async () => {
    const builtInDir = mkdtempSync(join(tmpdir(), 'order-builtin-'));
    const uploadedDir = mkdtempSync(join(tmpdir(), 'order-uploaded-'));
    try {
      writeManifest(join(builtInDir, 'shared'), 'test.agent.shared', '1.0.0');
      writeManifest(join(uploadedDir, 'shared'), 'test.agent.shared', '2.0.0');

      const builtInStore = new BuiltInPackageStore(builtInDir);
      await builtInStore.load();
      const uploadedStore = new UploadedPackageStore(
        join(uploadedDir, 'index.json'),
        uploadedDir,
      );
      await uploadedStore.load();
      await uploadedStore.register({
        id: 'test.agent.shared',
        version: '2.0.0',
        path: join(uploadedDir, 'shared'),
        uploaded_at: new Date().toISOString(),
        uploaded_by: 'test',
        sha256: 'x'.repeat(64),
        peers_missing: [],
        zip_bytes: 0,
        extracted_bytes: 0,
        file_count: 0,
      });

      const catalog = new PluginCatalog({
        manifestDir: '/nonexistent',
        extraSources: () => [
          ...builtInStore.list().map((p) => ({ packageRoot: p.path })),
          ...uploadedStore.list().map((p) => ({ packageRoot: p.path })),
        ],
      });
      await catalog.load();

      const winner = catalog.get('test.agent.shared');
      assert.equal(winner?.plugin.version, '2.0.0');
    } finally {
      rmSync(builtInDir, { recursive: true, force: true });
      rmSync(uploadedDir, { recursive: true, force: true });
    }
  });
});
