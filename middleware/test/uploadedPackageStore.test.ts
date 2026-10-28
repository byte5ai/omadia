import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  pruneRetiredPackageDirs,
  retirePackageDir,
  UploadedPackageStore,
  type UploadedPackage,
} from '../src/plugins/uploadedPackageStore.js';

/**
 * #1455 — the retired-copy layout: `<id>/.retired-<version>` beside
 * `<id>/<version>`. The store index only ever points at the live version, so
 * nothing else on the host knows a retired folder exists — which is why
 * retiring, pruning and deleting have to keep it accounted for here.
 */
describe('retired package copies', () => {
  let root: string;
  let store: UploadedPackageStore;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'retired-test-'));
    store = new UploadedPackageStore(
      path.join(root, 'index.json'),
      path.join(root, 'packages'),
    );
    await store.load();
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  async function layDown(id: string, version: string): Promise<UploadedPackage> {
    const dir = path.join(root, 'packages', id, version);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'manifest.yaml'), `# ${version}\n`, 'utf-8');
    return {
      id,
      version,
      path: dir,
      uploaded_at: '2026-10-01T00:00:00.000Z',
      uploaded_by: 'test@example.com',
      sha256: 'a'.repeat(64),
      peers_missing: [],
      zip_bytes: 1,
      extracted_bytes: 1,
      file_count: 1,
    };
  }

  it('renames the package aside with its contents and keeps only the newest copy', async () => {
    const logs: string[] = [];
    const first = await layDown('@test/retire', '1.0.0');
    const retired = await retirePackageDir(first, (m) => logs.push(m));

    assert.equal(retired, path.join(root, 'packages', '@test/retire', '.retired-1.0.0'));
    assert.equal(await fs.readFile(path.join(retired!, 'manifest.yaml'), 'utf-8'), '# 1.0.0\n');
    await assert.rejects(fs.access(first.path), 'the live path moved, not copied');
    assert.equal(logs.length, 0, 'a clean retire says nothing');

    // Retiring again drops the earlier copy: one per plugin.
    const second = await layDown('@test/retire', '1.1.0');
    const next = await retirePackageDir(second, (m) => logs.push(m));
    const left = await fs.readdir(path.join(root, 'packages', '@test/retire'));
    assert.deepEqual(left.sort(), ['.retired-1.1.0']);
    assert.equal(next, path.join(root, 'packages', '@test/retire', '.retired-1.1.0'));
  });

  it('reports no rollback copy instead of pretending, when the package is gone', async () => {
    const logs: string[] = [];
    const vanished = await layDown('@test/retire', '1.0.0');
    await fs.rm(vanished.path, { recursive: true, force: true });

    const retired = await retirePackageDir(vanished, (m) => logs.push(m));
    assert.equal(retired, null);
    assert.equal(logs.length, 1);
    assert.match(logs[0]!, /no rollback copy/);
  });

  it('removes the retired sibling when the package is deleted', async () => {
    const pkg = await layDown('@test/retire', '2.0.0');
    await store.register(pkg);
    const old = await layDown('@test/retire', '1.0.0');
    await retirePackageDir(old, () => undefined);

    assert.equal(await store.remove('@test/retire'), true);
    // The index pointed only at 2.0.0, so without the prune the retired copy
    // would sit on disk with nothing referring to it, forever.
    await assert.rejects(fs.access(path.join(root, 'packages', '@test/retire', '.retired-1.0.0')));
    await assert.rejects(fs.access(pkg.path));
  });

  // #1490 — removal used to leave `<id>/` behind, empty.
  it('removes the emptied id folder, and the scope folder only once it is empty', async () => {
    const a = await layDown('@test/one', '1.0.0');
    const b = await layDown('@test/two', '1.0.0');
    await store.register(a);
    await store.register(b);

    assert.equal(await store.remove('@test/one'), true);
    await assert.rejects(fs.access(path.join(root, 'packages', '@test/one')));
    // The scope still holds @test/two, so it stays.
    await fs.access(path.join(root, 'packages', '@test/two', '1.0.0'));

    assert.equal(await store.remove('@test/two'), true);
    await assert.rejects(fs.access(path.join(root, 'packages', '@test')));
    // The packages root itself is never removed.
    await fs.access(path.join(root, 'packages'));
  });

  it('prunes nothing and throws nothing for a directory that does not exist', async () => {
    await pruneRetiredPackageDirs(path.join(root, 'packages', '@test/absent'));
  });

  it('leaves live version directories alone', async () => {
    await layDown('@test/retire', '1.0.0');
    await layDown('@test/retire', '2.0.0');
    await pruneRetiredPackageDirs(path.join(root, 'packages', '@test/retire'));
    const left = await fs.readdir(path.join(root, 'packages', '@test/retire'));
    assert.deepEqual(left.sort(), ['1.0.0', '2.0.0']);
  });
});

describe('UploadedPackageStore.remove — containment (N02 security review)', () => {
  it('never deletes a stored path outside the packages root', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'contain-test-'));
    try {
      const outside = path.join(root, 'outside');
      await fs.mkdir(outside, { recursive: true });
      await fs.writeFile(path.join(outside, 'keep.txt'), 'x');
      const logs: string[] = [];
      const store = new UploadedPackageStore(
        path.join(root, 'index.json'),
        path.join(root, 'packages'),
        (m) => logs.push(m),
      );
      await store.load();
      await store.register({
        id: '@test/evil', version: '1.0.0', path: outside,
        uploaded_at: '', uploaded_by: '', sha256: 'a'.repeat(64),
        peers_missing: [], zip_bytes: 1, extracted_bytes: 1, file_count: 1,
      });
      assert.equal(await store.remove('@test/evil'), true);
      await fs.access(path.join(outside, 'keep.txt'));
      assert.ok(logs.some((l) => l.includes('outside')));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
