import {
  MemoryPathError,
  type MemoryAccessor,
  type MemoryEntryInfo,
  type MemoryStore,
} from '@omadia/plugin-api';

/**
 * Builds a MemoryAccessor that routes all reads/writes into a per-plugin,
 * **per-orchestrator** subtree of the host's MemoryStore:
 *
 *   /memories/orchestrators/<agentSlug>/plugins/<pluginId>/...
 *
 * The owning orchestrator (Agent) is resolved at CALL time via
 * `resolveAgentSlug` (backed by the turn-context Agent slug), so the same
 * plugin invoked under two different Agents writes to two disjoint trees —
 * strict per-orchestrator isolation, even for a plugin both Agents enable.
 * Outside a turn (activate-time writes, ad-hoc) the slug falls back to
 * `'default'`, preserving single-agent behaviour.
 *
 * Isolation is **structural**: the accessor cannot produce an absolute path
 * outside the plugin's per-orchestrator scope. Plugins cannot see each
 * other's — or another orchestrator's — memory because the accessor they
 * receive has no API to ask for it.
 *
 * Back-compat: before per-orchestrator isolation, plugin memory lived at
 * `/memories/agents/<pluginId>/...` (orchestrator-agnostic). For the default
 * Agent only, READ operations fall back to that legacy tree on a miss so
 * pre-isolation data stays reachable without a migration. Writes always go to
 * the new per-orchestrator path.
 *
 * Path rules (unchanged):
 *   - Input is relative (`notes.md`, `subdir/a.txt`).
 *   - Leading `/` is rejected — plugins must not think in absolute terms.
 *   - `..` segments are rejected.
 *   - Empty / dot-only paths resolve to the scope root (for `list`/`exists`).
 */
export function createMemoryAccessor(opts: {
  pluginId: string;
  store: MemoryStore;
  /**
   * Resolves the active orchestrator (Agent) slug for the current turn —
   * typically `() => turnContext.currentAgentSlug()`. `undefined` (no turn
   * context) falls back to the `'default'` Agent.
   */
  resolveAgentSlug?: () => string | undefined;
}): MemoryAccessor {
  const { pluginId, store } = opts;
  const resolveAgentSlug = opts.resolveAgentSlug ?? ((): undefined => undefined);
  const legacyPrefix = `/memories/agents/${pluginId}`;

  const currentSlug = (): string => resolveAgentSlug() ?? 'default';
  const scopePrefixFor = (slug: string): string =>
    `/memories/orchestrators/${slug}/plugins/${pluginId}`;

  const normalize = (relPath: string): string => {
    if (typeof relPath !== 'string') {
      throw new MemoryPathError('memory path must be a string');
    }
    if (relPath.startsWith('/')) {
      throw new MemoryPathError(
        `memory path must be relative (got absolute): ${relPath}`,
      );
    }
    if (relPath.includes('..')) {
      throw new MemoryPathError(`memory path must not contain '..': ${relPath}`);
    }
    if (relPath.includes('\u0000')) {
      throw new MemoryPathError('memory path must not contain null bytes');
    }
    // Empty / '.' / './' all point to the scope root.
    return relPath.replace(/^\.\/?|^$/, '');
  };

  /** Resolve a relative path against a given scope prefix. */
  const resolveAt = (prefix: string, relPath: string): string => {
    const trimmed = normalize(relPath);
    return trimmed.length === 0 ? prefix : `${prefix}/${trimmed}`;
  };

  const toRel = (prefix: string, abs: string): string => {
    if (abs === prefix) return '';
    if (abs.startsWith(prefix + '/')) return abs.slice(prefix.length + 1);
    // Stay defensive: don't leak out-of-scope paths back to plugin code.
    throw new MemoryPathError(`store returned out-of-scope path: ${abs}`);
  };

  /** Legacy read-through is only offered for the default Agent. */
  const legacyEnabled = (slug: string): boolean => slug === 'default';

  return {
    async readFile(relPath: string): Promise<string> {
      const slug = currentSlug();
      const prefix = scopePrefixFor(slug);
      try {
        return await store.readFile(resolveAt(prefix, relPath));
      } catch (err) {
        if (legacyEnabled(slug)) {
          // Pre-isolation data lived under /memories/agents/<pluginId>/.
          const legacyAbs = resolveAt(legacyPrefix, relPath);
          if (await store.fileExists(legacyAbs)) {
            return store.readFile(legacyAbs);
          }
        }
        throw err;
      }
    },

    async writeFile(relPath: string, content: string): Promise<void> {
      await store.writeFile(resolveAt(scopePrefixFor(currentSlug()), relPath), content);
    },

    async createFile(relPath: string, content: string): Promise<void> {
      await store.createFile(resolveAt(scopePrefixFor(currentSlug()), relPath), content);
    },

    async delete(relPath: string): Promise<void> {
      await store.delete(resolveAt(scopePrefixFor(currentSlug()), relPath));
    },

    async list(relPath: string): Promise<readonly MemoryEntryInfo[]> {
      const slug = currentSlug();
      const prefix = scopePrefixFor(slug);
      if (await store.directoryExists(prefix)) {
        const entries = await store.list(resolveAt(prefix, relPath));
        return entries.map(
          (e): MemoryEntryInfo => ({
            relPath: toRel(prefix, e.virtualPath),
            isDirectory: e.isDirectory,
            sizeBytes: e.sizeBytes,
          }),
        );
      }
      // New scope empty — fall back to legacy data for the default Agent.
      if (legacyEnabled(slug) && (await store.directoryExists(legacyPrefix))) {
        const entries = await store.list(resolveAt(legacyPrefix, relPath));
        return entries.map(
          (e): MemoryEntryInfo => ({
            relPath: toRel(legacyPrefix, e.virtualPath),
            isDirectory: e.isDirectory,
            sizeBytes: e.sizeBytes,
          }),
        );
      }
      // Plugin never wrote to its scope yet — surface as empty list rather
      // than a confusing "path not found" on the implicit scope root.
      return [];
    },

    async exists(relPath: string): Promise<boolean> {
      const slug = currentSlug();
      const abs = resolveAt(scopePrefixFor(slug), relPath);
      if ((await store.fileExists(abs)) || (await store.directoryExists(abs))) {
        return true;
      }
      if (legacyEnabled(slug)) {
        const legacyAbs = resolveAt(legacyPrefix, relPath);
        return (
          (await store.fileExists(legacyAbs)) ||
          (await store.directoryExists(legacyAbs))
        );
      }
      return false;
    },
  };
}
