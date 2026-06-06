import type { MemoryStore } from '@omadia/plugin-api';

/**
 * One-time memory migration — copy every file from a SOURCE MemoryStore into a
 * TARGET MemoryStore. The intended use is migrating the on-disk `/memories`
 * tree (FilesystemMemoryStore over `MEMORY_DIR`) into a freshly-selected
 * Postgres backend, so flipping `MEMORY_BACKEND` to `postgres` does not orphan
 * the existing filesystem data while the old volume is still mounted.
 *
 * KEY CONSTRAINT: `FilesystemMemoryStore.list(dir)` caps recursion at two
 * levels deep, so a single `list('/memories')` MISSES files nested deeper than
 * two levels (e.g. `/memories/orchestrators/<agent>/sub/deep/file.md`). The
 * walk here therefore does a proper recursive descent: it lists a directory
 * and, for every entry that is itself a directory, recurses into it — so every
 * FILE at ANY depth is collected. We rely only on the `isDirectory` flag the
 * store returns per entry, never on a single deep `list`.
 */

const MEMORIES_ROOT = '/memories';

/**
 * Recursively collect every file's virtualPath under `root`, at ANY depth.
 *
 * Implemented as an explicit BFS over directory entries so the 2-level `list`
 * cap is overcome: each `list(dir)` may return entries up to two levels deep,
 * but we only ever enqueue the DIRECTORY entries we discover and re-`list`
 * them, which guarantees full coverage of arbitrarily deep trees while
 * deduping paths visited via overlapping shallow listings.
 *
 * Tolerates a missing root (returns `[]`) so callers can run against a store
 * whose `/memories` directory does not yet exist.
 */
export async function walkAllFiles(
  store: MemoryStore,
  root: string = MEMORIES_ROOT,
): Promise<string[]> {
  if (!(await store.directoryExists(root))) {
    return [];
  }

  const files = new Set<string>();
  const visitedDirs = new Set<string>();
  const queue: string[] = [root];

  while (queue.length > 0) {
    const dir = queue.shift() as string;
    if (visitedDirs.has(dir)) continue;
    visitedDirs.add(dir);

    let entries;
    try {
      entries = await store.list(dir);
    } catch {
      // A directory that vanished mid-walk (or is otherwise unlistable) is
      // skipped rather than aborting the whole migration.
      continue;
    }

    for (const entry of entries) {
      // The shallow `list` can echo the directory itself or repeat entries
      // seen via a parent listing; guard against both.
      if (entry.virtualPath === dir) continue;
      if (entry.isDirectory) {
        if (!visitedDirs.has(entry.virtualPath)) {
          queue.push(entry.virtualPath);
        }
      } else {
        files.add(entry.virtualPath);
      }
    }
  }

  return [...files];
}

export interface MigrateMemoryOptions {
  /** When true, copy even files that already exist in the target. Default false. */
  overwrite?: boolean;
}

export interface MigrateMemoryResult {
  totalFiles: number;
  copied: number;
  skipped: number;
  failed: number;
  errors: Array<{ path: string; error: string }>;
}

/**
 * Copy every file from `source` into `target`. Per source file:
 *   - read its content;
 *   - if it already exists in `target` and `overwrite` is not set → skipped;
 *   - otherwise `writeFile` it → copied.
 *
 * Never throws for a per-file failure: failures are counted into `failed` and
 * recorded in `errors`, so one unreadable/unwritable file cannot abort the
 * whole run. The only way this rejects is a failure to ENUMERATE the source
 * (which `walkAllFiles` already tolerates for a missing root).
 */
export async function migrateMemory(
  source: MemoryStore,
  target: MemoryStore,
  opts: MigrateMemoryOptions = {},
): Promise<MigrateMemoryResult> {
  const overwrite = opts.overwrite === true;
  const paths = await walkAllFiles(source);

  const result: MigrateMemoryResult = {
    totalFiles: paths.length,
    copied: 0,
    skipped: 0,
    failed: 0,
    errors: [],
  };

  for (const path of paths) {
    try {
      if (!overwrite && (await target.fileExists(path))) {
        result.skipped += 1;
        continue;
      }
      const content = await source.readFile(path);
      await target.writeFile(path, content);
      result.copied += 1;
    } catch (err) {
      result.failed += 1;
      result.errors.push({
        path,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return result;
}

export interface PreviewMigrationResult {
  totalFiles: number;
  wouldCopy: number;
  alreadyPresent: number;
}

/**
 * Dry-run: enumerate the source and count how many files would be copied vs.
 * are already present in the target. Performs no writes.
 */
export async function previewMigration(
  source: MemoryStore,
  target: MemoryStore,
): Promise<PreviewMigrationResult> {
  const paths = await walkAllFiles(source);
  let alreadyPresent = 0;
  for (const path of paths) {
    if (await target.fileExists(path)) {
      alreadyPresent += 1;
    }
  }
  return {
    totalFiles: paths.length,
    wouldCopy: paths.length - alreadyPresent,
    alreadyPresent,
  };
}
