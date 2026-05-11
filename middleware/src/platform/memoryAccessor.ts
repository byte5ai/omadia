import {
  MemoryPathError,
  type MemoryAccessor,
  type MemoryEntryInfo,
  type MemoryStore,
} from '@omadia/plugin-api';

/**
 * Builds a MemoryAccessor that routes all reads/writes into a fixed
 * `/memories/agents/<agentId>/...` subtree of the host's MemoryStore.
 *
 * Isolation is **structural**: the accessor simply cannot produce an
 * absolute path outside the plugin's scope. Plugins cannot see each
 * other's memory because the accessor they receive has no API to ask for
 * it. That's stronger than an ACL check (no check to forget to enforce).
 *
 * Path rules:
 *   - Input is relative (`notes.md`, `subdir/a.txt`).
 *   - Leading `/` is rejected — plugins must not think in absolute terms.
 *   - `..` segments are rejected (underlying store would reject too, but
 *     fail-fast with a plugin-api error gives a cleaner diagnostic).
 *   - Empty / dot-only paths resolve to the scope root (for `list`/`exists`).
 */
export function createMemoryAccessor(opts: {
  agentId: string;
  store: MemoryStore;
}): MemoryAccessor {
  const { agentId, store } = opts;
  const scopePrefix = `/memories/agents/${agentId}`;

  const resolveScoped = (relPath: string): string => {
    if (typeof relPath !== 'string') {
      throw new MemoryPathError('memory path must be a string');
    }
    if (relPath.startsWith('/')) {
      throw new MemoryPathError(
        `memory path must be relative (got absolute): ${relPath}`,
      );
    }
    if (relPath.includes('..')) {
      throw new MemoryPathError(
        `memory path must not contain '..': ${relPath}`,
      );
    }
    if (relPath.includes('\u0000')) {
      throw new MemoryPathError('memory path must not contain null bytes');
    }
    // Normalize — empty / '.' / './' all point to scope root.
    const trimmed = relPath.replace(/^\.\/?|^$/, '');
    if (trimmed.length === 0) return scopePrefix;
    return `${scopePrefix}/${trimmed}`;
  };

  const toRel = (abs: string): string => {
    if (abs === scopePrefix) return '';
    if (abs.startsWith(scopePrefix + '/')) {
      return abs.slice(scopePrefix.length + 1);
    }
    // Shouldn't happen with a well-behaved MemoryStore, but stay defensive:
    // don't leak out-of-scope paths back to plugin code.
    throw new MemoryPathError(`store returned out-of-scope path: ${abs}`);
  };

  return {
    async readFile(relPath: string): Promise<string> {
      return store.readFile(resolveScoped(relPath));
    },

    async writeFile(relPath: string, content: string): Promise<void> {
      await store.writeFile(resolveScoped(relPath), content);
    },

    async createFile(relPath: string, content: string): Promise<void> {
      await store.createFile(resolveScoped(relPath), content);
    },

    async delete(relPath: string): Promise<void> {
      await store.delete(resolveScoped(relPath));
    },

    async list(relPath: string): Promise<readonly MemoryEntryInfo[]> {
      const absDir = resolveScoped(relPath);
      const scopeExists = await store.directoryExists(scopePrefix);
      if (!scopeExists) {
        // Plugin never wrote to its scope yet — surface as empty list
        // rather than a confusing "path not found" error on the implicit
        // scope root.
        return [];
      }
      const entries = await store.list(absDir);
      return entries.map(
        (e): MemoryEntryInfo => ({
          relPath: toRel(e.virtualPath),
          isDirectory: e.isDirectory,
          sizeBytes: e.sizeBytes,
        }),
      );
    },

    async exists(relPath: string): Promise<boolean> {
      const abs = resolveScoped(relPath);
      return (
        (await store.fileExists(abs)) || (await store.directoryExists(abs))
      );
    },
  };
}
