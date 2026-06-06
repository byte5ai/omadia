/**
 * Ephemeral, in-memory MemoryAccessor for the Builder preview runtime.
 *
 * Why this exists
 * ---------------
 * In a *real* install the kernel hands plugins a `ctx.memory` accessor backed
 * by the `@omadia/memory` provider plugin's MemoryStore (see
 * `platform/memoryAccessor.ts` + `platform/pluginContext.ts`). The preview
 * runtime, by design, wires NONE of the real platform services — it stands in
 * its own in-memory replacements for secrets and config and a no-op stub for
 * the ServiceRegistry. Memory was simply missing from that surface, so any
 * agent that calls `ctx.memory.{readFile,writeFile,exists,list,…}` in its
 * `activate-body` hit its own `if (!ctx.memory) throw …` null-guard the moment
 * preview-chat tried to activate it — surfacing as
 * `builder.preview_chat_failed: <id>: ctx.memory is required but unavailable`.
 * The manifest was correct the whole time; the preview context just had no
 * memory accessor to give.
 *
 * This module closes that gap with a Map-backed store that mirrors the
 * behaviour of `FilesystemMemoryStore` + `createMemoryAccessor` (relative-path
 * validation, structural scoping, 2-level `list` walk) WITHOUT importing the
 * provider plugin or plugin-api — keeping `previewRuntime.ts` self-contained
 * (same principle as the inline `PreviewUiRouteDescriptorInput` copy).
 *
 * Lifetime: one store per preview activation. Isolation between agents is
 * implicit — each activation constructs a fresh accessor over a fresh Map, so
 * there is nothing to leak across previews. The Map is dropped (and GC'd) when
 * the preview handle and its context go away; no explicit teardown needed.
 */

/** Mirror of `MemoryAccessor` from `@omadia/plugin-api` (and the boilerplate's
 *  `types.ts`). Inline-copied to keep the preview runtime free of a plugin-api
 *  dependency. */
export interface PreviewMemoryAccessor {
  readFile(relPath: string): Promise<string>;
  writeFile(relPath: string, content: string): Promise<void>;
  /** Create, fail-if-exists. */
  createFile(relPath: string, content: string): Promise<void>;
  delete(relPath: string): Promise<void>;
  list(relPath: string): Promise<readonly PreviewMemoryEntryInfo[]>;
  exists(relPath: string): Promise<boolean>;
}

export interface PreviewMemoryEntryInfo {
  readonly relPath: string;
  readonly isDirectory: boolean;
  readonly sizeBytes: number;
}

/** `list` walks at most this many levels below the requested directory —
 *  identical to `FilesystemMemoryStore`'s depth budget so preview output
 *  matches install. */
const LIST_MAX_DEPTH = 2;

/**
 * Normalize + validate a plugin-supplied relative memory path into a canonical
 * key (no leading/trailing slash, `.`/`./`/`''` → root `''`). Mirrors the
 * validation in `platform/memoryAccessor.ts:resolveScoped` so a path the real
 * accessor would reject is rejected here too (fail-fast, identical diagnostics
 * shape) rather than silently "working" only in preview.
 */
function normalizeRel(relPath: string): string {
  if (typeof relPath !== 'string') {
    throw new Error('memory path must be a string');
  }
  if (relPath.startsWith('/')) {
    throw new Error(`memory path must be relative (got absolute): ${relPath}`);
  }
  if (relPath.includes('..')) {
    throw new Error(`memory path must not contain '..': ${relPath}`);
  }
  if (relPath.includes('\u0000')) {
    throw new Error('memory path must not contain null bytes');
  }
  // Strip a leading './' and collapse empty / '.' to the scope root.
  const trimmed = relPath.replace(/^\.\/?|^$/, '').replace(/\/+$/, '');
  return trimmed;
}

/**
 * Build an ephemeral in-memory MemoryAccessor for one preview activation.
 */
export function createPreviewMemoryAccessor(): PreviewMemoryAccessor {
  // Map<normalized-relative-file-path, content>. Directories are implicit:
  // a directory "exists" iff some file key sits under it.
  const files = new Map<string, string>();

  const isDir = (key: string): boolean => {
    if (key === '') return files.size > 0; // root
    const prefix = key + '/';
    for (const k of files.keys()) {
      if (k.startsWith(prefix)) return true;
    }
    return false;
  };

  return {
    async readFile(relPath: string): Promise<string> {
      const key = normalizeRel(relPath);
      const content = files.get(key);
      if (content === undefined) {
        throw new Error(`Path not found: ${relPath}`);
      }
      return content;
    },

    async writeFile(relPath: string, content: string): Promise<void> {
      const key = normalizeRel(relPath);
      if (key === '') {
        throw new Error('memory path must point at a file, not the scope root');
      }
      // A key that is an implicit directory (some other file sits under it)
      // must not become a file too — otherwise the same path is both a
      // file key and a directory prefix, and `list()` would shadow the
      // children. FilesystemMemoryStore fails this write with EISDIR.
      if (isDir(key)) {
        throw new Error(`Path is a directory, not a file: ${relPath}`);
      }
      files.set(key, content);
    },

    async createFile(relPath: string, content: string): Promise<void> {
      const key = normalizeRel(relPath);
      if (key === '') {
        throw new Error('memory path must point at a file, not the scope root');
      }
      // Reject both an existing file and an existing implicit directory at
      // this path — mirrors FilesystemMemoryStore's fail-if-exists on a
      // path already taken by a directory.
      if (files.has(key) || isDir(key)) {
        throw new Error(`Path already exists: ${relPath}`);
      }
      files.set(key, content);
    },

    async delete(relPath: string): Promise<void> {
      const key = normalizeRel(relPath);
      if (key === '') {
        throw new Error('Refusing to delete the scope root.');
      }
      if (files.delete(key)) return; // single file
      // Directory delete — drop every descendant file.
      const prefix = key + '/';
      let removed = false;
      for (const k of [...files.keys()]) {
        if (k.startsWith(prefix)) {
          files.delete(k);
          removed = true;
        }
      }
      if (!removed) {
        throw new Error(`Path not found: ${relPath}`);
      }
    },

    async exists(relPath: string): Promise<boolean> {
      const key = normalizeRel(relPath);
      if (key === '') return files.size > 0;
      return files.has(key) || isDir(key);
    },

    async list(relPath: string): Promise<readonly PreviewMemoryEntryInfo[]> {
      // Mirror `createMemoryAccessor.list`: an unwritten scope lists as empty
      // rather than throwing a confusing "not found" on the implicit root.
      if (files.size === 0) return [];

      const base = normalizeRel(relPath);

      // A file path lists as a single file entry (matches FilesystemMemoryStore).
      if (base !== '' && files.has(base)) {
        return [
          {
            relPath: base,
            isDirectory: false,
            sizeBytes: Buffer.byteLength(files.get(base)!, 'utf8'),
          },
        ];
      }

      const dirExists = base === '' || isDir(base);
      if (!dirExists) {
        throw new Error(`Path not found: ${relPath}`);
      }

      const prefix = base === '' ? '' : base + '/';
      // Deduplicate emitted entries by relPath; always include the listed dir.
      const entries = new Map<string, PreviewMemoryEntryInfo>();
      entries.set(base, { relPath: base, isDirectory: true, sizeBytes: 0 });

      for (const [key, value] of files) {
        if (prefix !== '' && !key.startsWith(prefix)) continue;
        const relToBase = key.slice(prefix.length);
        if (relToBase === '') continue;
        const segs = relToBase.split('/');
        // Intermediate directories at depth 1..min(depth-1, MAX) below base.
        const dirDepth = Math.min(segs.length - 1, LIST_MAX_DEPTH);
        for (let d = 1; d <= dirDepth; d++) {
          const dirRel = prefix + segs.slice(0, d).join('/');
          if (!entries.has(dirRel)) {
            entries.set(dirRel, {
              relPath: dirRel,
              isDirectory: true,
              sizeBytes: 0,
            });
          }
        }
        // The file itself only when within the depth budget.
        if (segs.length <= LIST_MAX_DEPTH) {
          entries.set(key, {
            relPath: key,
            isDirectory: false,
            sizeBytes: Buffer.byteLength(value, 'utf8'),
          });
        }
      }

      return [...entries.values()].sort((a, b) =>
        a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0,
      );
    },
  };
}
