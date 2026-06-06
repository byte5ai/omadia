import { strict as assert } from 'node:assert';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FilesystemMemoryStore } from '@omadia/memory/dist/filesystem.js';

import {
  migrateMemory,
  previewMigration,
  walkAllFiles,
} from '../src/services/memoryMigration.js';

// ---------------------------------------------------------------------------
// One-time memory migration helpers. Exercised against a real
// FilesystemMemoryStore in a mkdtemp for BOTH the source and (a second
// tmpdir) the target — this proves the copy logic end-to-end without needing
// Postgres. Postgres as a target is covered by the PostgresMemoryStore
// conformance suite; the migration is backend-agnostic (it only uses the
// MemoryStore interface), so an FS→FS target is sufficient here.
//
// The key property under test: walkAllFiles overcomes the 2-level `list`
// recursion cap of FilesystemMemoryStore by walking directory entries, so
// files nested 3+ levels deep are still found and migrated.
// ---------------------------------------------------------------------------

describe('memoryMigration', () => {
  let srcDir: string;
  let tgtDir: string;
  let source: FilesystemMemoryStore;
  let target: FilesystemMemoryStore;

  beforeEach(async () => {
    srcDir = await mkdtemp(join(tmpdir(), 'memmig-src-'));
    tgtDir = await mkdtemp(join(tmpdir(), 'memmig-tgt-'));
    source = new FilesystemMemoryStore(srcDir);
    target = new FilesystemMemoryStore(tgtDir);
    await source.init();
    await target.init();

    // Depth 1: /memories/<file>
    await source.createFile('/memories/top.md', 'top');
    // Depth 2: /memories/<dir>/<file>
    await source.createFile('/memories/_rules/hr.md', 'rule');
    // Depth 3+: /memories/orchestrators/<agent>/sub/deep/file.md — beyond the
    // 2-level list cap, so a naive single list('/memories') would MISS this.
    await source.createFile(
      '/memories/orchestrators/a/sub/deep/file.md',
      'deep',
    );
    await source.createFile(
      '/memories/orchestrators/a/sub/another.md',
      'mid',
    );
    await source.createFile('/memories/orchestrators/b/notes.md', 'b-notes');
  });

  afterEach(async () => {
    await rm(srcDir, { recursive: true, force: true });
    await rm(tgtDir, { recursive: true, force: true });
  });

  it('walkAllFiles finds files at depth 1, 2 and 3+ (overcomes the list cap)', async () => {
    const files = await walkAllFiles(source);
    const set = new Set(files);

    assert.equal(files.length, 5, 'should find every file at any depth');
    assert.ok(set.has('/memories/top.md'), 'depth-1 file');
    assert.ok(set.has('/memories/_rules/hr.md'), 'depth-2 file');
    assert.ok(
      set.has('/memories/orchestrators/a/sub/deep/file.md'),
      'depth-5 file — proves the 2-level list cap is overcome',
    );
    assert.ok(set.has('/memories/orchestrators/a/sub/another.md'), 'depth-4 file');
    assert.ok(set.has('/memories/orchestrators/b/notes.md'), 'depth-3 file');

    // No duplicates despite overlapping shallow listings.
    assert.equal(set.size, files.length, 'paths are deduped');
  });

  it('walkAllFiles tolerates a missing /memories root', async () => {
    const emptyDir = await mkdtemp(join(tmpdir(), 'memmig-empty-'));
    // A store whose root exists but has no /memories subtree.
    const empty = new FilesystemMemoryStore(emptyDir);
    await empty.init();
    try {
      assert.deepEqual(await walkAllFiles(empty), []);
    } finally {
      await rm(emptyDir, { recursive: true, force: true });
    }
  });

  it('migrateMemory copies all files FS→target with correct counts', async () => {
    const result = await migrateMemory(source, target);

    assert.equal(result.totalFiles, 5);
    assert.equal(result.copied, 5);
    assert.equal(result.skipped, 0);
    assert.equal(result.failed, 0);
    assert.deepEqual(result.errors, []);

    // Content carried over verbatim, including the deep file.
    assert.equal(
      await target.readFile('/memories/orchestrators/a/sub/deep/file.md'),
      'deep',
    );
    assert.equal(await target.readFile('/memories/top.md'), 'top');
  });

  it('second run with overwrite=false skips all already-present files', async () => {
    await migrateMemory(source, target);
    const second = await migrateMemory(source, target, { overwrite: false });

    assert.equal(second.totalFiles, 5);
    assert.equal(second.copied, 0);
    assert.equal(second.skipped, 5);
    assert.equal(second.failed, 0);
  });

  it('run with overwrite=true re-copies all files', async () => {
    await migrateMemory(source, target);
    // Mutate the source so we can observe the overwrite took effect.
    await source.writeFile('/memories/top.md', 'top-v2');

    const third = await migrateMemory(source, target, { overwrite: true });

    assert.equal(third.totalFiles, 5);
    assert.equal(third.copied, 5);
    assert.equal(third.skipped, 0);
    assert.equal(third.failed, 0);
    assert.equal(await target.readFile('/memories/top.md'), 'top-v2');
  });

  it('previewMigration counts match (no writes)', async () => {
    const before = await previewMigration(source, target);
    assert.equal(before.totalFiles, 5);
    assert.equal(before.wouldCopy, 5);
    assert.equal(before.alreadyPresent, 0);
    // Dry-run wrote nothing — none of the source files landed in the target.
    assert.equal(await target.fileExists('/memories/top.md'), false);
    assert.equal(
      await target.fileExists('/memories/orchestrators/a/sub/deep/file.md'),
      false,
    );

    await migrateMemory(source, target);

    const after = await previewMigration(source, target);
    assert.equal(after.totalFiles, 5);
    assert.equal(after.wouldCopy, 0);
    assert.equal(after.alreadyPresent, 5);
  });
});
