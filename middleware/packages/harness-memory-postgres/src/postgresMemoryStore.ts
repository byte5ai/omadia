import {
  MemoryAlreadyExistsError,
  MemoryInvalidPathError,
  MemoryIsDirectoryError,
  MemoryPathNotFoundError,
} from '@omadia/memory';
import type { MemoryEntry, MemoryStore } from '@omadia/plugin-api';
import type { Pool } from 'pg';

const MEMORY_ROOT = '/memories';

/**
 * Postgres-backed memory store. Maps the virtual `/memories` namespace onto
 * rows of a single `memory_files` table (one row per file). A drop-in
 * alternative to @omadia/memory's `FilesystemMemoryStore` — it replicates the
 * exact same contract (path validation, error classes, 2-level `list` walk).
 *
 * Directories are IMPLICIT: there are no directory rows. A directory exists
 * iff some file row has it as a strict path prefix. The `/memories` root
 * always exists. As a consequence, an empty directory left behind after its
 * last file is deleted does NOT persist (the filesystem store keeps the inode;
 * the implicit-directory model cannot). This is the single behavioural
 * divergence from `FilesystemMemoryStore`.
 *
 * The store does NOT own the pool — it receives the shared `graphPool` and
 * never calls `pool.end()`.
 */
export class PostgresMemoryStore implements MemoryStore {
  constructor(private readonly pool: Pool) {}

  async list(virtualPath: string): Promise<MemoryEntry[]> {
    const p = this.normalize(virtualPath);

    const fileRow = await this.pool.query<{ size_bytes: number }>(
      'SELECT size_bytes FROM memory_files WHERE virtual_path = $1',
      [p],
    );
    if ((fileRow.rowCount ?? 0) > 0) {
      const row = fileRow.rows[0];
      if (!row) throw new MemoryPathNotFoundError(virtualPath);
      return [{ virtualPath: p, isDirectory: false, sizeBytes: row.size_bytes }];
    }

    if (!(await this.directoryExists(p))) {
      throw new MemoryPathNotFoundError(virtualPath);
    }

    const descendants = await this.pool.query<{
      virtual_path: string;
      size_bytes: number;
    }>(
      'SELECT virtual_path, size_bytes FROM memory_files WHERE virtual_path LIKE $1',
      [`${p}/%`],
    );

    return walk(p, descendants.rows, 2, 0);
  }

  async fileExists(virtualPath: string): Promise<boolean> {
    const p = this.normalize(virtualPath);
    const r = await this.pool.query(
      'SELECT 1 FROM memory_files WHERE virtual_path = $1',
      [p],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async directoryExists(virtualPath: string): Promise<boolean> {
    const p = this.normalize(virtualPath);
    if (p === MEMORY_ROOT) return true;

    const fileRow = await this.pool.query(
      'SELECT 1 FROM memory_files WHERE virtual_path = $1',
      [p],
    );
    if ((fileRow.rowCount ?? 0) > 0) return false;

    const prefixed = await this.pool.query(
      'SELECT 1 FROM memory_files WHERE virtual_path LIKE $1 LIMIT 1',
      [`${p}/%`],
    );
    return (prefixed.rowCount ?? 0) > 0;
  }

  async readFile(virtualPath: string): Promise<string> {
    const p = this.normalize(virtualPath);
    const r = await this.pool.query<{ content: string }>(
      'SELECT content FROM memory_files WHERE virtual_path = $1',
      [p],
    );
    if ((r.rowCount ?? 0) > 0) {
      const row = r.rows[0];
      if (!row) throw new MemoryPathNotFoundError(virtualPath);
      return row.content;
    }
    if (await this.directoryExists(p)) {
      throw new MemoryIsDirectoryError(virtualPath);
    }
    throw new MemoryPathNotFoundError(virtualPath);
  }

  async createFile(virtualPath: string, content: string): Promise<void> {
    const p = this.normalize(virtualPath);
    if ((await this.fileExists(p)) || (await this.directoryExists(p))) {
      throw new MemoryAlreadyExistsError(virtualPath);
    }
    const size = Buffer.byteLength(content, 'utf8');
    await this.pool.query(
      'INSERT INTO memory_files (virtual_path, content, size_bytes) VALUES ($1, $2, $3)',
      [p, content, size],
    );
  }

  async writeFile(virtualPath: string, content: string): Promise<void> {
    const p = this.normalize(virtualPath);
    if (await this.directoryExists(p)) {
      throw new MemoryIsDirectoryError(virtualPath);
    }
    const size = Buffer.byteLength(content, 'utf8');
    await this.pool.query(
      `INSERT INTO memory_files (virtual_path, content, size_bytes)
       VALUES ($1, $2, $3)
       ON CONFLICT (virtual_path) DO UPDATE
         SET content = EXCLUDED.content,
             size_bytes = EXCLUDED.size_bytes,
             updated_at = now()`,
      [p, content, size],
    );
  }

  async delete(virtualPath: string): Promise<void> {
    const p = this.normalize(virtualPath);
    if (p === MEMORY_ROOT) {
      throw new MemoryInvalidPathError('Refusing to delete the /memories root.');
    }

    const fileDel = await this.pool.query(
      'DELETE FROM memory_files WHERE virtual_path = $1',
      [p],
    );
    if ((fileDel.rowCount ?? 0) > 0) return;

    const dirDel = await this.pool.query(
      'DELETE FROM memory_files WHERE virtual_path LIKE $1',
      [`${p}/%`],
    );
    if ((dirDel.rowCount ?? 0) > 0) return;

    throw new MemoryPathNotFoundError(virtualPath);
  }

  async rename(
    fromVirtualPath: string,
    toVirtualPath: string,
  ): Promise<void> {
    const fp = this.normalize(fromVirtualPath);
    const tp = this.normalize(toVirtualPath);

    const fromIsFile = await this.fileExists(fp);
    const fromIsDir = !fromIsFile && (await this.directoryExists(fp));
    if (!fromIsFile && !fromIsDir) {
      throw new MemoryPathNotFoundError(fromVirtualPath);
    }

    if ((await this.fileExists(tp)) || (await this.directoryExists(tp))) {
      throw new MemoryAlreadyExistsError(toVirtualPath);
    }

    if (fromIsFile) {
      await this.pool.query(
        'UPDATE memory_files SET virtual_path = $1, updated_at = now() WHERE virtual_path = $2',
        [tp, fp],
      );
      return;
    }

    // Directory move: rewrite the prefix of every descendant row atomically.
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE memory_files
           SET virtual_path = $1 || substring(virtual_path from $2::int),
               updated_at = now()
         WHERE virtual_path LIKE $3`,
        [tp, fp.length + 1, `${fp}/%`],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Validates and canonicalises a virtual path. Mirrors
   * `FilesystemMemoryStore.toAbsolute`'s validation rules, but returns the
   * normalised virtual path (no on-disk resolution).
   */
  private normalize(virtualPath: string): string {
    if (typeof virtualPath !== 'string' || virtualPath.length === 0) {
      throw new MemoryInvalidPathError('Path must be a non-empty string.');
    }
    if (virtualPath.includes('\0')) {
      throw new MemoryInvalidPathError('Path contains a NUL byte.');
    }
    const lowered = virtualPath.toLowerCase();
    if (
      virtualPath.includes('..') ||
      lowered.includes('%2e%2e') ||
      lowered.includes('%2f..') ||
      lowered.includes('..%2f')
    ) {
      throw new MemoryInvalidPathError(
        `Path contains traversal sequence: ${virtualPath}`,
      );
    }
    if (!virtualPath.startsWith(MEMORY_ROOT)) {
      throw new MemoryInvalidPathError(
        `Path must start with /memories, got: ${virtualPath}`,
      );
    }

    // Collapse duplicate slashes, strip trailing slash (except bare root).
    let normalised = virtualPath.replace(/\/+/g, '/');
    if (normalised !== MEMORY_ROOT) {
      normalised = normalised.replace(/\/$/, '');
    }

    if (normalised !== MEMORY_ROOT && !normalised.startsWith(`${MEMORY_ROOT}/`)) {
      throw new MemoryInvalidPathError(
        `Path must start with /memories, got: ${virtualPath}`,
      );
    }
    return normalised;
  }
}

/**
 * JS re-implementation of `FilesystemMemoryStore.walk` (maxDepth = 2) over a
 * flat list of descendant file rows. Directory `sizeBytes` is reported as 0
 * (the FS store reports the inode size — a cosmetic field that conformance
 * tests do NOT assert).
 */
function walk(
  dir: string,
  descendants: ReadonlyArray<{ virtual_path: string; size_bytes: number }>,
  maxDepth: number,
  depth: number,
): MemoryEntry[] {
  const entries: MemoryEntry[] = [
    { virtualPath: dir, isDirectory: true, sizeBytes: 0 },
  ];
  if (depth >= maxDepth) return entries;

  const prefix = `${dir}/`;
  // Map immediate child name -> { isDir, sizeBytes? }.
  const children = new Map<string, { isDir: boolean; sizeBytes: number }>();
  for (const row of descendants) {
    if (!row.virtual_path.startsWith(prefix)) continue;
    const rest = row.virtual_path.slice(prefix.length);
    const slash = rest.indexOf('/');
    const name = slash === -1 ? rest : rest.slice(0, slash);
    if (name.length === 0) continue;
    if (name.startsWith('.') || name === 'node_modules') continue;
    const isDir = slash !== -1;
    if (!children.has(name)) {
      children.set(name, { isDir, sizeBytes: isDir ? 0 : row.size_bytes });
    }
  }

  for (const name of [...children.keys()].sort()) {
    const child = children.get(name);
    if (!child) continue;
    const childPath = `${prefix}${name}`;
    if (child.isDir) {
      entries.push(...walk(childPath, descendants, maxDepth, depth + 1));
    } else {
      entries.push({
        virtualPath: childPath,
        isDirectory: false,
        sizeBytes: child.sizeBytes,
      });
    }
  }
  return entries;
}
