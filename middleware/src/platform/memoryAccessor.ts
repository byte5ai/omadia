import {
  MemoryPathError,
  type MemoryAccessor,
  type MemoryEntry,
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
 * Relative-path normalisation shared by every view in this module. Rejects
 * absolute paths, `..` segments and NUL bytes before any store call; empty /
 * `.` / `./` resolve to the scope root (returned as `''`).
 */
function normalizeRelPath(relPath: string): string {
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
}

/** Resolve a relative path against a given scope prefix. */
function resolveInScope(prefix: string, relPath: string): string {
  const trimmed = normalizeRelPath(relPath);
  return trimmed.length === 0 ? prefix : `${prefix}/${trimmed}`;
}

/** Store path → path relative to `prefix`; refuses anything outside it. */
function relativeToScope(prefix: string, abs: string): string {
  if (abs === prefix) return '';
  if (abs.startsWith(prefix + '/')) return abs.slice(prefix.length + 1);
  // Stay defensive: don't leak out-of-scope paths back to plugin code.
  throw new MemoryPathError(`store returned out-of-scope path: ${abs}`);
}

/**
 * The per-plugin, per-orchestrator scope that BOTH `ctx.memory`
 * (`createMemoryAccessor`) and the scoped `memory` tool view
 * (`createPluginMemoryToolStore`) resolve against. One function, so the two
 * paths cannot disagree about where a plugin's memory lives:
 *
 *   /memories/orchestrators/<agentSlug>/plugins/<pluginId>
 *
 * The slug is resolved per call; `undefined` (no turn) ⇒ `'default'`. The
 * pre-isolation tree `/memories/agents/<pluginId>` is offered as a READ-ONLY
 * fallback for the default Agent only.
 */
function pluginMemoryScope(
  pluginId: string,
  resolveAgentSlug: () => string | undefined,
): () => MemoryScope {
  const legacyPrefix = `/memories/agents/${pluginId}`;
  return () => {
    const slug = resolveAgentSlug() ?? 'default';
    const prefix = `/memories/orchestrators/${slug}/plugins/${pluginId}`;
    return slug === 'default' ? { prefix, legacyPrefix } : { prefix };
  };
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
  const resolveAt = resolveInScope;
  const toRel = relativeToScope;

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
  const resolveAgentSlug = opts.resolveAgentSlug ?? ((): undefined => undefined);
  return createScopedMemoryAccessor(
    opts.store,
    pluginMemoryScope(opts.pluginId, resolveAgentSlug),
  );
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

const MEMORIES_ROOT = '/memories';

/**
 * A `MemoryStore` view in which the model-facing `/memories` root IS the
 * plugin's own `ctx.memory` scope (`pluginMemoryScope`). Built for
 * `ctx.tools.invoke('memory', …)` (#909): the kernel runs a
 * `MemoryToolHandler` over this view, so a plugin replaying a memory-tool
 * call gets the exact replies of the model-facing tool, but only ever inside
 * `/memories/orchestrators/<agentSlug>/plugins/<pluginId>/`. Same bijection
 * idea as `OrchestratorMemoryNamespacer` for Agents, minus the shared
 * pass-through segments — a plugin has no business in `core`/`sessions`.
 *
 * Path rules:
 *   - Input must be `/memories` or start with `/memories/`; anything else
 *     throws `MemoryPathError`.
 *   - The remainder passes the same `normalizeRelPath` gate as `ctx.memory`
 *     (`..`, NUL rejected) before any store call.
 *   - `list` entries are mapped back to `/memories/...`; a store entry outside
 *     the scope throws instead of leaking.
 *
 * Legacy tree (default Agent only) is READ-ONLY, as for `ctx.memory`: a miss
 * in the primary prefix falls back to it for `fileExists`,
 * `directoryExists`, `readFile` and `list`; writes, deletes and renames only
 * ever touch the primary prefix.
 *
 * The scope root always "exists" (an empty listing, not "path not found"),
 * matching `ctx.memory.list('')` on a scope nothing was written to yet.
 */
export function createPluginMemoryToolStore(opts: {
  pluginId: string;
  store: MemoryStore;
  /** Same contract as `createMemoryAccessor`'s `resolveAgentSlug`. */
  resolveAgentSlug?: () => string | undefined;
}): MemoryStore {
  const { store } = opts;
  const scope = pluginMemoryScope(
    opts.pluginId,
    opts.resolveAgentSlug ?? ((): undefined => undefined),
  );

  /** `/memories/...` → path relative to the scope root (`''` = root). */
  const toScopeRel = (virtualPath: string): string => {
    if (typeof virtualPath !== 'string') {
      throw new MemoryPathError('memory path must be a string');
    }
    // Same canonicalisation the stores apply: collapse `//`, drop a trailing
    // slash. Nothing here can widen the path — `..` is refused below.
    const collapsed = virtualPath.replace(/\/+/g, '/').replace(/(.)\/$/, '$1');
    if (collapsed === MEMORIES_ROOT) return '';
    if (!collapsed.startsWith(`${MEMORIES_ROOT}/`)) {
      throw new MemoryPathError(
        `memory path must be ${MEMORIES_ROOT} or start with ${MEMORIES_ROOT}/: ${virtualPath}`,
      );
    }
    return normalizeRelPath(collapsed.slice(MEMORIES_ROOT.length + 1));
  };

  const primary = (virtualPath: string): string =>
    resolveInScope(scope().prefix, toScopeRel(virtualPath));

  /** Legacy store path for a READ, or `undefined` when no fallback applies. */
  const legacy = (virtualPath: string): string | undefined => {
    const { legacyPrefix } = scope();
    return legacyPrefix === undefined
      ? undefined
      : resolveInScope(legacyPrefix, toScopeRel(virtualPath));
  };

  const listUnder = async (
    prefix: string,
    rel: string,
  ): Promise<MemoryEntry[]> => {
    const entries = await store.list(resolveInScope(prefix, rel));
    return entries.map((e) => {
      const inner = relativeToScope(prefix, e.virtualPath);
      return {
        ...e,
        virtualPath:
          inner.length === 0 ? MEMORIES_ROOT : `${MEMORIES_ROOT}/${inner}`,
      };
    });
  };

  return {
    async list(virtualPath: string): Promise<MemoryEntry[]> {
      const rel = toScopeRel(virtualPath);
      const { prefix, legacyPrefix } = scope();
      const abs = resolveInScope(prefix, rel);
      if ((await store.fileExists(abs)) || (await store.directoryExists(abs))) {
        return listUnder(prefix, rel);
      }
      if (legacyPrefix !== undefined) {
        const legacyAbs = resolveInScope(legacyPrefix, rel);
        if (
          (await store.fileExists(legacyAbs)) ||
          (await store.directoryExists(legacyAbs))
        ) {
          return listUnder(legacyPrefix, rel);
        }
      }
      if (rel.length === 0) return [];
      // Surface the store's own "not found" for the primary path.
      return listUnder(prefix, rel);
    },

    async fileExists(virtualPath: string): Promise<boolean> {
      if (await store.fileExists(primary(virtualPath))) return true;
      const legacyAbs = legacy(virtualPath);
      return legacyAbs !== undefined && store.fileExists(legacyAbs);
    },

    async directoryExists(virtualPath: string): Promise<boolean> {
      if (toScopeRel(virtualPath).length === 0) return true;
      if (await store.directoryExists(primary(virtualPath))) return true;
      const legacyAbs = legacy(virtualPath);
      return legacyAbs !== undefined && store.directoryExists(legacyAbs);
    },

    async readFile(virtualPath: string): Promise<string> {
      const abs = primary(virtualPath);
      try {
        return await store.readFile(abs);
      } catch (err) {
        const legacyAbs = legacy(virtualPath);
        if (legacyAbs !== undefined && (await store.fileExists(legacyAbs))) {
          return store.readFile(legacyAbs);
        }
        throw err;
      }
    },

    // `async` so a path violation REJECTS like every other store error
    // instead of throwing synchronously out of a Promise-returning method.
    async createFile(virtualPath: string, content: string): Promise<void> {
      await store.createFile(primary(virtualPath), content);
    },

    async writeFile(virtualPath: string, content: string): Promise<void> {
      await store.writeFile(primary(virtualPath), content);
    },

    async delete(virtualPath: string): Promise<void> {
      await store.delete(primary(virtualPath));
    },

    async rename(fromVirtualPath: string, toVirtualPath: string): Promise<void> {
      await store.rename(primary(fromVirtualPath), primary(toVirtualPath));
    },
  };
}
