import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { MemoryEntry, MemoryStore } from '@omadia/plugin-api';

/**
 * Filesystem-backed memory store. Maps the virtual /memories namespace onto a real
 * directory on disk, with strict path-traversal protection.
 */
export class FilesystemMemoryStore implements MemoryStore {
  private readonly rootAbs: string;

  constructor(rootDir: string) {
    this.rootAbs = path.resolve(rootDir);
  }

  async init(): Promise<void> {
    await fs.mkdir(this.rootAbs, { recursive: true });
  }

  async list(virtualPath: string): Promise<MemoryEntry[]> {
    const abs = this.toAbsolute(virtualPath);
    const stat = await fs.stat(abs).catch(() => null);
    if (!stat) {
      throw new MemoryPathNotFoundError(virtualPath);
    }
    if (!stat.isDirectory()) {
      return [
        {
          virtualPath,
          isDirectory: false,
          sizeBytes: stat.size,
        },
      ];
    }
    return this.walk(abs, virtualPath, 2);
  }

  async fileExists(virtualPath: string): Promise<boolean> {
    const abs = this.toAbsolute(virtualPath);
    const stat = await fs.stat(abs).catch(() => null);
    return stat?.isFile() ?? false;
  }

  async directoryExists(virtualPath: string): Promise<boolean> {
    const abs = this.toAbsolute(virtualPath);
    const stat = await fs.stat(abs).catch(() => null);
    return stat?.isDirectory() ?? false;
  }

  async readFile(virtualPath: string): Promise<string> {
    const abs = this.toAbsolute(virtualPath);
    const stat = await fs.stat(abs).catch(() => null);
    if (!stat) {
      throw new MemoryPathNotFoundError(virtualPath);
    }
    if (stat.isDirectory()) {
      throw new MemoryIsDirectoryError(virtualPath);
    }
    return fs.readFile(abs, 'utf8');
  }

  async createFile(virtualPath: string, content: string): Promise<void> {
    const abs = this.toAbsolute(virtualPath);
    const existing = await fs.stat(abs).catch(() => null);
    if (existing) {
      throw new MemoryAlreadyExistsError(virtualPath);
    }
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf8');
  }

  async writeFile(virtualPath: string, content: string): Promise<void> {
    const abs = this.toAbsolute(virtualPath);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf8');
  }

  async delete(virtualPath: string): Promise<void> {
    const abs = this.toAbsolute(virtualPath);
    if (abs === this.rootAbs) {
      throw new MemoryInvalidPathError('Refusing to delete the /memories root.');
    }
    const stat = await fs.stat(abs).catch(() => null);
    if (!stat) {
      throw new MemoryPathNotFoundError(virtualPath);
    }
    await fs.rm(abs, { recursive: true, force: true });
  }

  async rename(fromVirtualPath: string, toVirtualPath: string): Promise<void> {
    const fromAbs = this.toAbsolute(fromVirtualPath);
    const toAbs = this.toAbsolute(toVirtualPath);
    const fromStat = await fs.stat(fromAbs).catch(() => null);
    if (!fromStat) {
      throw new MemoryPathNotFoundError(fromVirtualPath);
    }
    const toStat = await fs.stat(toAbs).catch(() => null);
    if (toStat) {
      throw new MemoryAlreadyExistsError(toVirtualPath);
    }
    await fs.mkdir(path.dirname(toAbs), { recursive: true });
    await fs.rename(fromAbs, toAbs);
  }

  private toAbsolute(virtualPath: string): string {
    if (typeof virtualPath !== 'string' || virtualPath.length === 0) {
      throw new MemoryInvalidPathError('Path must be a non-empty string.');
    }
    if (virtualPath.includes('\u0000')) {
      throw new MemoryInvalidPathError('Path contains null byte.');
    }
    // Reject traversal sequences (literal and URL-encoded).
    const lowered = virtualPath.toLowerCase();
    if (
      virtualPath.includes('..') ||
      lowered.includes('%2e%2e') ||
      lowered.includes('%2f..') ||
      lowered.includes('..%2f')
    ) {
      throw new MemoryInvalidPathError(`Path contains traversal sequence: ${virtualPath}`);
    }
    if (!virtualPath.startsWith('/memories')) {
      throw new MemoryInvalidPathError(`Path must start with /memories, got: ${virtualPath}`);
    }
    const relative = virtualPath.slice('/memories'.length).replace(/^\/+/, '');
    const joined = path.resolve(this.rootAbs, relative);
    // Canonicalize: resolved path must remain inside rootAbs.
    if (joined !== this.rootAbs && !joined.startsWith(this.rootAbs + path.sep)) {
      throw new MemoryInvalidPathError(`Resolved path escapes memory root: ${virtualPath}`);
    }
    return joined;
  }

  private async walk(
    absDir: string,
    virtualDir: string,
    maxDepth: number,
    currentDepth = 0,
  ): Promise<MemoryEntry[]> {
    const entries: MemoryEntry[] = [];
    const dirStat = await fs.stat(absDir);
    entries.push({ virtualPath: virtualDir, isDirectory: true, sizeBytes: dirStat.size });

    if (currentDepth >= maxDepth) return entries;

    const children = await fs.readdir(absDir);
    for (const child of children.sort()) {
      if (child.startsWith('.') || child === 'node_modules') continue;
      const absChild = path.join(absDir, child);
      const virtualChild = `${virtualDir.replace(/\/+$/, '')}/${child}`;
      const stat = await fs.stat(absChild);
      if (stat.isDirectory()) {
        entries.push(...(await this.walk(absChild, virtualChild, maxDepth, currentDepth + 1)));
      } else {
        entries.push({
          virtualPath: virtualChild,
          isDirectory: false,
          sizeBytes: stat.size,
        });
      }
    }
    return entries;
  }
}

export class MemoryPathNotFoundError extends Error {
  constructor(virtualPath: string) {
    super(`Path not found: ${virtualPath}`);
    this.name = 'MemoryPathNotFoundError';
  }
}

export class MemoryAlreadyExistsError extends Error {
  constructor(virtualPath: string) {
    super(`Path already exists: ${virtualPath}`);
    this.name = 'MemoryAlreadyExistsError';
  }
}

export class MemoryIsDirectoryError extends Error {
  constructor(virtualPath: string) {
    super(`Path is a directory, not a file: ${virtualPath}`);
    this.name = 'MemoryIsDirectoryError';
  }
}

export class MemoryInvalidPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MemoryInvalidPathError';
  }
}
