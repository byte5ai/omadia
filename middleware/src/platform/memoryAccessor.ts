import {
  MemoryPathError,
  type MemoryAccessor,
  type MemoryEntryInfo,
  type MemoryStore,
} from '@omadia/plugin-api';

/**
 * The subtree one accessor is pinned to, resolved at CALL time.
 *
 * `legacyPrefix` is an optional READ-ONLY fallback tree consulted on a miss in
 * `prefix`. Absent ⇒ no fallback at all.
 */
interface MemoryScope {
  readonly prefix: string;
  readonly legacyPrefix?: string;
}

/**
 * The shared engine behind every accessor in this module: relative-path
 * normalisation plus the prefix/legacy-prefix resolution, with the scope
 * resolved per call so a caller can move its subtree between turns.
 *
 * This is the choke point the isolation guarantee rests on — `normalize`
 * rejects absolute paths, `..` segments and NUL bytes before any store call,
 * and `toRel` refuses to hand back a store path that escaped the prefix.
 */
function createScopedMemoryAccessor(
  store: MemoryStore,
  scope: () => MemoryScope,
): MemoryAccessor {
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

  const listAt = async (
    prefix: string,
    relPath: string,
  ): Promise<readonly MemoryEntryInfo[]> => {
    const entries = await store.list(resolveAt(prefix, relPath));
    return entries.map(
      (e): MemoryEntryInfo => ({
        relPath: toRel(prefix, e.virtualPath),
        isDirectory: e.isDirectory,
        sizeBytes: e.sizeBytes,
      }),
    );
  };

  return {
    async readFile(relPath: string): Promise<string> {
      const { prefix, legacyPrefix } = scope();
      try {
        return await store.readFile(resolveAt(prefix, relPath));
      } catch (err) {
        if (legacyPrefix !== undefined) {
          const legacyAbs = resolveAt(legacyPrefix, relPath);
          if (await store.fileExists(legacyAbs)) {
            return store.readFile(legacyAbs);
          }
        }
        throw err;
      }
    },

    async writeFile(relPath: string, content: string): Promise<void> {
      await store.writeFile(resolveAt(scope().prefix, relPath), content);
    },

    async createFile(relPath: string, content: string): Promise<void> {
      await store.createFile(resolveAt(scope().prefix, relPath), content);
    },

    async delete(relPath: string): Promise<void> {
      await store.delete(resolveAt(scope().prefix, relPath));
    },

    async list(relPath: string): Promise<readonly MemoryEntryInfo[]> {
      const { prefix, legacyPrefix } = scope();
      if (await store.directoryExists(prefix)) {
        return listAt(prefix, relPath);
      }
      // New scope empty — fall back to legacy data where one is configured.
      if (
        legacyPrefix !== undefined &&
        (await store.directoryExists(legacyPrefix))
      ) {
        return listAt(legacyPrefix, relPath);
      }
      // Nothing was ever written to this scope — surface as an empty list
      // rather than a confusing "path not found" on the implicit scope root.
      return [];
    },

    async exists(relPath: string): Promise<boolean> {
      const { prefix, legacyPrefix } = scope();
      const abs = resolveAt(prefix, relPath);
      if ((await store.fileExists(abs)) || (await store.directoryExists(abs))) {
        return true;
      }
      if (legacyPrefix !== undefined) {
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

  return createScopedMemoryAccessor(store, () => {
    const slug = resolveAgentSlug() ?? 'default';
    const prefix = `/memories/orchestrators/${slug}/plugins/${pluginId}`;
    // Pre-isolation data lived under /memories/agents/<pluginId>/; the
    // read-through is only offered for the default Agent.
    return slug === 'default' ? { prefix, legacyPrefix } : { prefix };
  });
}

/**
 * Builds a read-capable MemoryAccessor pinned to one FIXED absolute subtree of
 * the store — no per-turn resolution, no legacy fallback.
 *
 * Added for the operator-facing `/memories/contexts` listing (epic #860, wave
 * W2a): an authenticated operator has to browse the chat-context trees, and
 * the only thing between that listing and the rest of `/memories` is this
 * accessor's structural scoping. It is the same choke point plugins get —
 * `..`, absolute paths and NUL bytes are rejected before any store call, and
 * a store entry that escaped the root is refused on the way back out.
 *
 * `root` must be an absolute `/memories…` path without traversal segments; a
 * violation throws at CONSTRUCTION time, so a bad root can never become a
 * runtime path.
 */
export function createRootedMemoryAccessor(opts: {
  store: MemoryStore;
  /** Absolute virtual path, e.g. `/memories/contexts`. No trailing slash. */
  root: string;
}): MemoryAccessor {
  const root = opts.root;
  if (!root.startsWith('/memories')) {
    throw new MemoryPathError(`memory root must start with /memories: ${root}`);
  }
  if (root.endsWith('/')) {
    throw new MemoryPathError(`memory root must not end with '/': ${root}`);
  }
  if (root.includes('..') || root.includes('//') || root.includes('\u0000')) {
    throw new MemoryPathError(`memory root is not normalised: ${root}`);
  }
  return createScopedMemoryAccessor(opts.store, () => ({ prefix: root }));
}
