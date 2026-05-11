import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { MemoryStore } from '@omadia/plugin-api';

export type MemorySeedMode = 'missing' | 'overwrite' | 'skip';

interface SeederOptions {
  seedDir: string;
  store: MemoryStore;
  mode: MemorySeedMode;
  /** Virtual prefix under /memories where seeded files land. Default: /memories. */
  virtualRoot?: string;
}

export interface SeedResult {
  mode: MemorySeedMode;
  files: Array<{
    virtualPath: string;
    action: 'created' | 'overwritten' | 'skipped-missing' | 'skipped-exists';
  }>;
}

/**
 * Copies files from a seed directory (bundled with the source) into the memory store
 * on startup. Subdirectories under `seedDir` become subpaths under `/memories/`.
 *
 * Modes:
 * - `missing` — only create files that don't already exist in the store. Preserves
 *   runtime-written content.
 * - `overwrite` — always write the repo version. Use for hard rules that must stay
 *   pinned to the source of truth.
 * - `skip` — no-op.
 */
export class MemorySeeder {
  private readonly seedDir: string;
  private readonly store: MemoryStore;
  private readonly mode: MemorySeedMode;
  private readonly virtualRoot: string;

  constructor(options: SeederOptions) {
    this.seedDir = options.seedDir;
    this.store = options.store;
    this.mode = options.mode;
    this.virtualRoot = options.virtualRoot ?? '/memories';
  }

  async run(): Promise<SeedResult> {
    const result: SeedResult = { mode: this.mode, files: [] };
    if (this.mode === 'skip') return result;

    const seedDirAbs = path.resolve(this.seedDir);
    const exists = await fs
      .stat(seedDirAbs)
      .then((s) => s.isDirectory())
      .catch(() => false);
    if (!exists) {
      result.files.push({
        virtualPath: seedDirAbs,
        action: 'skipped-missing',
      });
      return result;
    }

    const entries = await walkFiles(seedDirAbs);
    for (const abs of entries) {
      const relative = path.relative(seedDirAbs, abs).split(path.sep).join('/');
      const virtualPath = `${this.virtualRoot}/${relative}`;
      const content = await fs.readFile(abs, 'utf8');

      if (this.mode === 'missing') {
        if (await this.store.fileExists(virtualPath)) {
          result.files.push({ virtualPath, action: 'skipped-exists' });
          continue;
        }
        await this.store.createFile(virtualPath, content);
        result.files.push({ virtualPath, action: 'created' });
      } else {
        // overwrite
        const existed = await this.store.fileExists(virtualPath);
        await this.store.writeFile(virtualPath, content);
        result.files.push({
          virtualPath,
          action: existed ? 'overwritten' : 'created',
        });
      }
    }
    return result;
  }
}

async function walkFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const stack: string[] = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    const children = await fs.readdir(current, { withFileTypes: true });
    for (const child of children) {
      if (child.name.startsWith('.')) continue;
      const abs = path.join(current, child.name);
      if (child.isDirectory()) {
        stack.push(abs);
      } else if (child.isFile()) {
        out.push(abs);
      }
    }
  }
  return out.sort();
}
