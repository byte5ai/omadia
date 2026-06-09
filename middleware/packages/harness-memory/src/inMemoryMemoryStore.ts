import type { MemoryEntry, MemoryStore } from '@omadia/plugin-api';

import {
  MemoryAlreadyExistsError,
  MemoryInvalidPathError,
  MemoryIsDirectoryError,
  MemoryPathNotFoundError,
} from './errors.js';

const MEMORY_ROOT = '/memories';

/**
 * RAM-backed memory store. Holds canonical virtualPath → content in a single
 * `Map`. A drop-in alternative to `FilesystemMemoryStore` /
 * `PostgresMemoryStore` — it replicates the exact same contract (path
 * validation, error classes, implicit directories, 2-level `list` walk).
 *
 * Directories are IMPLICIT: there are no directory entries. A directory exists
 * iff some file path has it as a strict path prefix. The `/memories` root
 * always exists. As with `PostgresMemoryStore`, an empty directory left behind
 * after its last file is deleted does NOT persist.
 */
export class InMemoryMemoryStore implements MemoryStore {
  private readonly files = new Map<string, string>();

  async list(virtualPath: string): Promise<MemoryEntry[]> {
    const p = this.normalize(virtualPath);

    const content = this.files.get(p);
    if (content !== undefined) {
      return [
        { virtualPath: p, isDirectory: false, sizeBytes: byteLength(content) },
      ];
    }

    if (!(await this.directoryExists(p))) {
      throw new MemoryPathNotFoundError(virtualPath);
    }

    const descendants: Array<{ virtual_path: string; size_bytes: number }> = [];
    for (const [path, body] of this.files) {
      if (path.startsWith(`${p}/`)) {
        descendants.push({ virtual_path: path, size_bytes: byteLength(body) });
      }
    }

    return walk(p, descendants, 2, 0);
  }

  async fileExists(virtualPath: string): Promise<boolean> {
    const p = this.normalize(virtualPath);
    return this.files.has(p);
  }

  async directoryExists(virtualPath: string): Promise<boolean> {
    const p = this.normalize(virtualPath);
    if (p === MEMORY_ROOT) return true;
    if (this.files.has(p)) return false;

    const prefix = `${p}/`;
    for (const path of this.files.keys()) {
      if (path.startsWith(prefix)) return true;
    }
    return false;
  }

  async readFile(virtualPath: string): Promise<string> {
    const p = this.normalize(virtualPath);
    const content = this.files.get(p);
    if (content !== undefined) {
      return content;
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
    this.files.set(p, content);
  }

  async writeFile(virtualPath: string, content: string): Promise<void> {
    const p = this.normalize(virtualPath);
    if (await this.directoryExists(p)) {
      throw new MemoryIsDirectoryError(virtualPath);
    }
    this.files.set(p, content);
  }

  async delete(virtualPath: string): Promise<void> {
    const p = this.normalize(virtualPath);
    if (p === MEMORY_ROOT) {
      throw new MemoryInvalidPathError('Refusing to delete the /memories root.');
    }

    if (this.files.delete(p)) return;

    const prefix = `${p}/`;
    let removed = false;
    for (const path of [...this.files.keys()]) {
      if (path.startsWith(prefix)) {
        this.files.delete(path);
        removed = true;
      }
    }
    if (removed) return;

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
      const content = this.files.get(fp);
      this.files.delete(fp);
      if (content !== undefined) this.files.set(tp, content);
      return;
    }

    // Directory move: rewrite the prefix of every descendant.
    const prefix = `${fp}/`;
    for (const [path, body] of [...this.files.entries()]) {
      if (path.startsWith(prefix)) {
        this.files.delete(path);
        this.files.set(`${tp}/${path.slice(prefix.length)}`, body);
      }
    }
  }

  /**
   * Validates and canonicalises a virtual path. Mirrors
   * `PostgresMemoryStore.normalize` exactly.
   */
  private normalize(virtualPath: string): string {
    if (typeof virtualPath !== 'string' || virtualPath.length === 0) {
      throw new MemoryInvalidPathError('Path must be a non-empty string.');
    }
    if (virtualPath.includes(' ')) {
      throw new MemoryInvalidPathError('Path contains a space.');
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

function byteLength(content: string): number {
  return Buffer.byteLength(content, 'utf8');
}

/**
 * JS re-implementation of `FilesystemMemoryStore.walk` (maxDepth = 2) over a
 * flat list of descendant file entries. Directory `sizeBytes` is reported as 0.
 * Mirrors `PostgresMemoryStore`'s `walk` precisely.
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
