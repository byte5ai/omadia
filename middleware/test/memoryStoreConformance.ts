import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MemoryAlreadyExistsError,
  MemoryInvalidPathError,
  MemoryIsDirectoryError,
  MemoryPathNotFoundError,
} from '@omadia/memory';
import type { MemoryEntry, MemoryStore } from '@omadia/plugin-api';

export interface ConformanceHarness {
  store: MemoryStore;
  cleanup: () => Promise<void>;
}

/**
 * Backend-agnostic conformance suite for the MemoryStore contract. Both
 * FilesystemMemoryStore and PostgresMemoryStore must satisfy it identically.
 *
 * `makeStore` returns a freshly-isolated, empty store plus a cleanup hook.
 * Directory `sizeBytes` is intentionally NOT asserted (the FS store reports
 * the inode size; the PG store reports 0 — a cosmetic divergence).
 */
export function runMemoryStoreConformance(
  makeStore: () => Promise<ConformanceHarness>,
  label: string,
): void {
  describe(`MemoryStore conformance — ${label}`, () => {
    async function withStore(
      fn: (store: MemoryStore) => Promise<void>,
    ): Promise<void> {
      const { store, cleanup } = await makeStore();
      try {
        await fn(store);
      } finally {
        await cleanup();
      }
    }

    it('createFile + readFile roundtrip', () =>
      withStore(async (store) => {
        await store.createFile('/memories/a.md', 'hello');
        assert.equal(await store.readFile('/memories/a.md'), 'hello');
      }));

    it('createFile twice → MemoryAlreadyExistsError', () =>
      withStore(async (store) => {
        await store.createFile('/memories/a.md', 'one');
        await assert.rejects(
          () => store.createFile('/memories/a.md', 'two'),
          MemoryAlreadyExistsError,
        );
      }));

    it('writeFile overwrites existing content', () =>
      withStore(async (store) => {
        await store.createFile('/memories/a.md', 'one');
        await store.writeFile('/memories/a.md', 'two');
        assert.equal(await store.readFile('/memories/a.md'), 'two');
      }));

    it('writeFile creates a new file (upsert)', () =>
      withStore(async (store) => {
        await store.writeFile('/memories/new.md', 'fresh');
        assert.equal(await store.readFile('/memories/new.md'), 'fresh');
      }));

    it('readFile missing → MemoryPathNotFoundError', () =>
      withStore(async (store) => {
        await assert.rejects(
          () => store.readFile('/memories/nope.md'),
          MemoryPathNotFoundError,
        );
      }));

    it('readFile on a directory → MemoryIsDirectoryError', () =>
      withStore(async (store) => {
        await store.createFile('/memories/dir/file.md', 'x');
        await assert.rejects(
          () => store.readFile('/memories/dir'),
          MemoryIsDirectoryError,
        );
      }));

    it('fileExists / directoryExists truth table', () =>
      withStore(async (store) => {
        await store.createFile('/memories/dir/file.md', 'x');

        assert.equal(await store.fileExists('/memories/dir/file.md'), true);
        assert.equal(await store.fileExists('/memories/dir'), false);
        assert.equal(await store.fileExists('/memories/missing.md'), false);

        assert.equal(await store.directoryExists('/memories'), true);
        assert.equal(await store.directoryExists('/memories/dir'), true);
        assert.equal(await store.directoryExists('/memories/dir/file.md'), false);
        assert.equal(await store.directoryExists('/memories/nope'), false);
      }));

    it('writeFile onto a directory rejects', () =>
      withStore(async (store) => {
        await store.createFile('/memories/dir/file.md', 'x');
        // NOTE: the exact error class differs by backend — the FS store
        // surfaces a raw EISDIR while the PG store throws
        // MemoryIsDirectoryError. The shared contract is only that the write
        // is refused, so we assert rejection without pinning the class.
        await assert.rejects(() => store.writeFile('/memories/dir', 'oops'));
      }));

    it('createFile onto a directory → MemoryAlreadyExistsError', () =>
      withStore(async (store) => {
        await store.createFile('/memories/dir/file.md', 'x');
        await assert.rejects(
          () => store.createFile('/memories/dir', 'oops'),
          MemoryAlreadyExistsError,
        );
      }));

    it('traversal sequences → MemoryInvalidPathError', () =>
      withStore(async (store) => {
        for (const bad of [
          '/memories/../etc/passwd',
          '/memories/%2e%2e/x',
          '/memories/a%2f..',
          '/memories/..%2fb',
        ]) {
          await assert.rejects(
            () => store.readFile(bad),
            MemoryInvalidPathError,
            `expected ${bad} to be rejected`,
          );
        }
      }));

    it('non-/memories path → MemoryInvalidPathError', () =>
      withStore(async (store) => {
        await assert.rejects(
          () => store.readFile('/etc/passwd'),
          MemoryInvalidPathError,
        );
        await assert.rejects(
          () => store.createFile('/other/x.md', 'x'),
          MemoryInvalidPathError,
        );
      }));

    it('empty / non-string path → MemoryInvalidPathError', () =>
      withStore(async (store) => {
        await assert.rejects(
          () => store.readFile(''),
          MemoryInvalidPathError,
        );
      }));

    it('delete file removes it', () =>
      withStore(async (store) => {
        await store.createFile('/memories/a.md', 'x');
        await store.delete('/memories/a.md');
        assert.equal(await store.fileExists('/memories/a.md'), false);
      }));

    it('delete directory removes descendants recursively', () =>
      withStore(async (store) => {
        await store.createFile('/memories/dir/one.md', '1');
        await store.createFile('/memories/dir/sub/two.md', '2');
        await store.delete('/memories/dir');
        assert.equal(await store.directoryExists('/memories/dir'), false);
        assert.equal(await store.fileExists('/memories/dir/one.md'), false);
        assert.equal(await store.fileExists('/memories/dir/sub/two.md'), false);
      }));

    it('delete missing path → MemoryPathNotFoundError', () =>
      withStore(async (store) => {
        await assert.rejects(
          () => store.delete('/memories/nope'),
          MemoryPathNotFoundError,
        );
      }));

    it("delete '/memories' root → MemoryInvalidPathError", () =>
      withStore(async (store) => {
        await assert.rejects(
          () => store.delete('/memories'),
          MemoryInvalidPathError,
        );
      }));

    it('rename file moves content', () =>
      withStore(async (store) => {
        await store.createFile('/memories/from.md', 'payload');
        await store.rename('/memories/from.md', '/memories/to.md');
        assert.equal(await store.fileExists('/memories/from.md'), false);
        assert.equal(await store.readFile('/memories/to.md'), 'payload');
      }));

    it('rename directory moves all descendants', () =>
      withStore(async (store) => {
        await store.createFile('/memories/old/a.md', 'A');
        await store.createFile('/memories/old/sub/b.md', 'B');
        await store.rename('/memories/old', '/memories/new');

        assert.equal(await store.directoryExists('/memories/old'), false);
        assert.equal(await store.directoryExists('/memories/new'), true);
        assert.equal(await store.readFile('/memories/new/a.md'), 'A');
        assert.equal(await store.readFile('/memories/new/sub/b.md'), 'B');
      }));

    it('rename onto existing → MemoryAlreadyExistsError', () =>
      withStore(async (store) => {
        await store.createFile('/memories/a.md', 'A');
        await store.createFile('/memories/b.md', 'B');
        await assert.rejects(
          () => store.rename('/memories/a.md', '/memories/b.md'),
          MemoryAlreadyExistsError,
        );
      }));

    it('rename missing source → MemoryPathNotFoundError', () =>
      withStore(async (store) => {
        await assert.rejects(
          () => store.rename('/memories/ghost', '/memories/x'),
          MemoryPathNotFoundError,
        );
      }));

    it('list of a file returns a single entry', () =>
      withStore(async (store) => {
        await store.createFile('/memories/solo.md', 'abc');
        const entries = await store.list('/memories/solo.md');
        assert.deepEqual(entries, [
          { virtualPath: '/memories/solo.md', isDirectory: false, sizeBytes: 3 },
        ]);
      }));

    it('list of a missing path → MemoryPathNotFoundError', () =>
      withStore(async (store) => {
        await assert.rejects(
          () => store.list('/memories/nowhere'),
          MemoryPathNotFoundError,
        );
      }));

    it('list of a populated tree matches the FS 2-level walk ordering', () =>
      withStore(async (store) => {
        await store.createFile('/memories/orchestrators/a/notes.md', 'notes');
        await store.createFile('/memories/orchestrators/a/sub/deep.md', 'deep');
        await store.createFile('/memories/orchestrators/b/x.md', 'x');

        const entries = await store.list('/memories/orchestrators');

        // 2-level walk from /memories/orchestrators (depth 0):
        //   orchestrators            (dir, depth 0)
        //     a                      (dir, depth 1)
        //       notes.md             (file, depth 2)
        //       sub                  (dir, depth 2 — children NOT expanded)
        //     b                      (dir, depth 1)
        //       x.md                 (file, depth 2)
        const shape = entries.map((e: MemoryEntry) => ({
          virtualPath: e.virtualPath,
          isDirectory: e.isDirectory,
        }));

        assert.deepEqual(shape, [
          { virtualPath: '/memories/orchestrators', isDirectory: true },
          { virtualPath: '/memories/orchestrators/a', isDirectory: true },
          { virtualPath: '/memories/orchestrators/a/notes.md', isDirectory: false },
          { virtualPath: '/memories/orchestrators/a/sub', isDirectory: true },
          { virtualPath: '/memories/orchestrators/b', isDirectory: true },
          { virtualPath: '/memories/orchestrators/b/x.md', isDirectory: false },
        ]);

        // File sizeBytes must still be reported accurately.
        const notes = entries.find(
          (e: MemoryEntry) => e.virtualPath === '/memories/orchestrators/a/notes.md',
        );
        assert.ok(notes);
        assert.equal(notes.sizeBytes, 5);
      }));
  });
}
