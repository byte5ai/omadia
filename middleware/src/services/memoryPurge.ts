import type { MemoryStore } from '@omadia/plugin-api';

/**
 * Danger-Zone scratch-memory purge helpers (WS3, backend).
 *
 * These operate on the ROOT (undecorated) {@link MemoryStore} so a purge
 * reaches EVERY agent's subtree, not a single per-orchestrator scope. They
 * are deliberately backend-agnostic: they only use the existing
 * `list` + `delete` surface, so the same code works against both the
 * filesystem store and the Postgres store without any new interface method.
 *
 * Physical layout (see harness-orchestrator `scopedMemoryStore` /
 * `orchestratorMemoryNamespacer`):
 *
 *   /memories/orchestrators/<slug>/...   — per-agent private tree
 *   /memories/_rules, /memories/_brand   — shared seed (brand/conventions)
 *   /memories/core                       — shared kernel namespace
 *   /memories/sessions, /chat-sessions   — shared session scratch
 *
 * The seed prefixes below are PROTECTED from `axis: 'all'` purges unless the
 * caller explicitly opts into `reseed` (in which case the caller is expected
 * to re-seed them afterwards).
 */

export type MemoryPurgeAxis = 'all' | 'agent' | 'user' | 'team' | 'channel';

/**
 * Top-level `/memories/...` entries that hold seed / shared kernel data, plus
 * durable per-user settings that a scratch purge must not wipe. Protected from
 * `axis: 'all'` unless `reseed` is requested. Stored as the leaf entry names
 * (the segment directly under `/memories`).
 */
export const PROTECTED_SEED_ENTRIES: readonly string[] = [
  '_rules',
  '_brand',
  'core',
  'sessions',
  'chat-sessions',
  // Per-user UI preferences (Lume palette/appearance, issue #287). Not seed
  // data, but a durable cross-device user setting — a Danger-Zone scratch
  // purge should not silently reset every operator's palette. A full `reseed`
  // purge still clears it (the explicit "wipe everything" path).
  'ui-prefs',
];

const MEMORIES_ROOT = '/memories';

interface PurgeMemoryOptions {
  /** When true, an `axis: 'all'` purge ALSO removes the protected seed
   *  prefixes (caller re-seeds afterwards). Ignored for non-'all' axes. */
  reseed?: boolean;
}

/** Leaf name of a top-level `/memories/<name>` entry, or null if the entry is
 *  not a direct child of `/memories`. */
function topLevelName(virtualPath: string): string | null {
  if (!virtualPath.startsWith(`${MEMORIES_ROOT}/`)) return null;
  const rest = virtualPath.slice(MEMORIES_ROOT.length + 1);
  if (rest.length === 0) return null;
  const slash = rest.indexOf('/');
  return slash === -1 ? rest : rest.slice(0, slash);
}

/**
 * Compute the set of top-level `/memories/<name>` entries that a purge would
 * delete, given the axis + selector. Returns absolute virtual paths.
 *
 *   - 'all'   → every top-level entry except the protected seed prefixes
 *               (unless `reseed`, which includes them).
 *   - 'agent' → the single `/memories/orchestrators/<selector>` subtree.
 *   - others  → [] (scratch is agent-scoped; user/team/channel act on KG only).
 */
async function resolvePurgeTargets(
  store: MemoryStore,
  axis: MemoryPurgeAxis,
  selector: string | undefined,
  reseed: boolean,
): Promise<string[]> {
  if (axis === 'agent') {
    const slug = (selector ?? '').trim();
    if (slug.length === 0) {
      throw Object.assign(new Error('selector_required'), {
        code: 'selector_required',
      });
    }
    const target = `${MEMORIES_ROOT}/orchestrators/${slug}`;
    return (await store.directoryExists(target)) ? [target] : [];
  }

  if (axis === 'all') {
    const entries = await store.list(MEMORIES_ROOT);
    const seen = new Set<string>();
    const targets: string[] = [];
    for (const entry of entries) {
      const name = topLevelName(entry.virtualPath);
      if (name === null || seen.has(name)) continue;
      seen.add(name);
      if (!reseed && PROTECTED_SEED_ENTRIES.includes(name)) continue;
      targets.push(`${MEMORIES_ROOT}/${name}`);
    }
    return targets;
  }

  // 'user' | 'team' | 'channel' — scratch memory is agent-scoped, so these
  // axes have no scratch footprint. They act only on the Knowledge-Graph.
  return [];
}

/**
 * Count the scratch entries a purge WOULD delete — dry-run preview. Never
 * mutates. Returns the number of top-level `/memories/...` entries removed
 * (NOT a recursive file count): one per agent subtree / seed prefix.
 */
export async function previewMemoryPurge(
  store: MemoryStore,
  axis: MemoryPurgeAxis,
  selector?: string,
  options: PurgeMemoryOptions = {},
): Promise<number> {
  const targets = await resolvePurgeTargets(
    store,
    axis,
    selector,
    options.reseed === true,
  );
  return targets.length;
}

/**
 * Execute the scratch purge. Deletes the resolved top-level entries and
 * returns how many were removed. `delete` is recursive (per the MemoryStore
 * contract), so deleting `/memories/orchestrators/<slug>` removes the whole
 * subtree.
 */
export async function purgeMemory(
  store: MemoryStore,
  axis: MemoryPurgeAxis,
  selector: string | undefined,
  options: PurgeMemoryOptions = {},
): Promise<number> {
  const targets = await resolvePurgeTargets(
    store,
    axis,
    selector,
    options.reseed === true,
  );
  let deleted = 0;
  for (const target of targets) {
    await store.delete(target);
    deleted += 1;
  }
  return deleted;
}
