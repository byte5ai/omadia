import { memoryContextKey } from '@omadia/channel-sdk';
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
 *   /memories/orchestrators/<slug>/...             — per-agent private tree
 *   /memories/contexts/<slug>/<axis>/<ctxKey>/...  — per-agent × chat-context
 *                                                    tree (axis = team |
 *                                                    channel | user)
 *   /memories/_rules, /memories/_brand             — shared seed
 *   /memories/core                                 — shared kernel namespace
 *   /memories/sessions, /chat-sessions             — shared session scratch
 *
 * The seed prefixes below are PROTECTED from `axis: 'all'` purges unless the
 * caller explicitly opts into `reseed` (in which case the caller is expected
 * to re-seed them afterwards). `contexts` is deliberately NOT among them: it
 * is ordinary scratch, so an `axis: 'all'` purge takes it along for free.
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

/** Root of the per-agent × chat-context scratch trees. A top-level `/memories`
 *  entry like any other — NOT protected, so `axis: 'all'` clears it. */
const CONTEXTS_ROOT = `${MEMORIES_ROOT}/contexts`;

/** The purge axes that address a chat context rather than an agent. */
const CONTEXT_AXES = ['team', 'channel', 'user'] as const;

type ContextPurgeAxis = (typeof CONTEXT_AXES)[number];

function isContextAxis(axis: MemoryPurgeAxis): axis is ContextPurgeAxis {
  return (CONTEXT_AXES as readonly string[]).includes(axis);
}

function selectorRequired(): Error {
  return Object.assign(new Error('selector_required'), {
    code: 'selector_required',
  });
}

interface PurgeMemoryOptions {
  /** When true, an `axis: 'all'` purge ALSO removes the protected seed
   *  prefixes (caller re-seeds afterwards). Ignored for non-'all' axes. */
  reseed?: boolean;
}

/** First path segment of `virtualPath` below `parent`, or null when the entry
 *  is not inside `parent`. `list` walks two levels deep, so a caller that only
 *  wants the DIRECT children has to fold the grandchildren back up. */
function childName(parent: string, virtualPath: string): string | null {
  if (!virtualPath.startsWith(`${parent}/`)) return null;
  const rest = virtualPath.slice(parent.length + 1);
  if (rest.length === 0) return null;
  const slash = rest.indexOf('/');
  return slash === -1 ? rest : rest.slice(0, slash);
}

/** Leaf name of a top-level `/memories/<name>` entry, or null if the entry is
 *  not a direct child of `/memories`. */
function topLevelName(virtualPath: string): string | null {
  return childName(MEMORIES_ROOT, virtualPath);
}

/** Distinct direct children of `parent`, or `[]` when `parent` does not exist.
 *  `list` throws `MemoryPathNotFoundError` on a missing directory, so the
 *  existence probe is load-bearing: an installation that has never written a
 *  context tree has no `/memories/contexts` at all. */
async function directChildren(
  store: MemoryStore,
  parent: string,
): Promise<string[]> {
  if (!(await store.directoryExists(parent))) return [];
  const entries = await store.list(parent);
  const names: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const name = childName(parent, entry.virtualPath);
    if (name === null || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

function invalidSelector(): Error {
  return Object.assign(
    new Error(
      'a context selector must be spelled "<channelType>~<id>", e.g. "teams~19:abc@thread.tacv2" (raw native id) or "teams~19-abc-thread-tacv2-a1b2c3d4e5f60718" (the key shown in the memory browser)',
    ),
    { code: 'invalid_selector' },
  );
}

/**
 * The `ctxKey` candidates an operator-typed context selector may name, as path
 * segments under `/memories/contexts/<agent>/<axis>/`.
 *
 * A context key is `${channelType}~${safeKey(nativeId)}` (see
 * {@link memoryContextKey}). The operator may legitimately type either
 * spelling, and the two are NOT interchangeable through one derivation:
 *
 *  - the RAW native id (`teams~19:abc@thread.tacv2`) has to be derived, and
 *  - the DERIVED key copied out of the memory browser must NOT be derived a
 *    second time. `memoryContextKey` is deliberately not idempotent on its own
 *    digest shape — that would make a hashed context pre-imageable, which is
 *    the hole this key exists to close.
 *
 * So both readings are resolved and the union of the trees they actually name
 * is purged. The candidate set is at most two, both are keys of the requesting
 * axis, and the preview counts exactly the trees the delete will remove — the
 * operator sees the real number before confirming.
 *
 * A selector with no `~` cannot name a context at all: the channel type is
 * missing, so nothing could ever match. It is REJECTED rather than passed
 * through, because a Danger-Zone gesture that silently deletes nothing while
 * reporting success is worse than an error — the shipped placeholder used to
 * invite exactly that spelling.
 */
function contextKeyCandidates(selector: string | undefined): string[] {
  const raw = (selector ?? '').trim();
  if (raw.length === 0) throw selectorRequired();

  const separator = raw.indexOf('~');
  if (separator <= 0 || separator === raw.length - 1) throw invalidSelector();

  const derived = memoryContextKey(raw.slice(0, separator), raw.slice(separator + 1));
  return derived === raw ? [raw] : [raw, derived];
}

/**
 * Compute the set of top-level `/memories/<name>` entries that a purge would
 * delete, given the axis + selector. Returns absolute virtual paths.
 *
 *   - 'all'   → every top-level entry except the protected seed prefixes
 *               (unless `reseed`, which includes them). `contexts` is not
 *               protected, so it is included.
 *   - 'agent' → everything that belongs to one agent: its
 *               `/memories/orchestrators/<selector>` tree AND its whole
 *               `/memories/contexts/<selector>` context forest.
 *   - 'team' | 'channel' | 'user' → one chat context ACROSS every agent:
 *               `/memories/contexts/<each agent>/<axis>/<ctxKey>`. The
 *               isolation axis is agent × context (context trees live under the
 *               agent slug because agent memory is never shared between
 *               agents), so purging a context means enumerating the agents.
 *
 * Returned paths are always the DEEPEST node that may be removed wholesale;
 * `delete` is recursive, so no descendant needs to be listed.
 */
async function resolvePurgeTargets(
  store: MemoryStore,
  axis: MemoryPurgeAxis,
  selector: string | undefined,
  reseed: boolean,
): Promise<string[]> {
  if (axis === 'agent') {
    const slug = (selector ?? '').trim();
    if (slug.length === 0) throw selectorRequired();

    const candidates = [
      `${MEMORIES_ROOT}/orchestrators/${slug}`,
      `${CONTEXTS_ROOT}/${slug}`,
    ];
    const targets: string[] = [];
    for (const candidate of candidates) {
      if (await store.directoryExists(candidate)) targets.push(candidate);
    }
    return targets;
  }

  if (isContextAxis(axis)) {
    const ctxKeys = contextKeyCandidates(selector);
    const targets: string[] = [];
    const seen = new Set<string>();
    for (const agentSlug of await directChildren(store, CONTEXTS_ROOT)) {
      for (const ctxKey of ctxKeys) {
        const target = `${CONTEXTS_ROOT}/${agentSlug}/${axis}/${ctxKey}`;
        if (seen.has(target)) continue;
        seen.add(target);
        if (await store.directoryExists(target)) targets.push(target);
      }
    }
    return targets;
  }

  // axis === 'all' — every top-level entry the seed guard lets through.
  // `contexts` is one of them (it is not in PROTECTED_SEED_ENTRIES), so a full
  // purge clears the context forest without naming it here.
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

/**
 * Count the scratch entries a purge WOULD delete — dry-run preview. Never
 * mutates. Returns the number of TARGETS removed, not a recursive file count:
 * one per agent subtree / seed prefix, and — for a context axis — one per AGENT
 * that holds the named context. A team present in three agents therefore
 * previews as 3, which is the honest number of trees the operator is about to
 * lose. Preview and execute share `resolvePurgeTargets`, so the number the UI
 * shows is by construction the number the delete acts on.
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
 * Execute the scratch purge. Deletes the resolved targets and returns how many
 * were removed. `delete` is recursive (per the MemoryStore contract), so
 * deleting `/memories/orchestrators/<slug>` or
 * `/memories/contexts/<slug>/team/<ctxKey>` removes the whole subtree.
 */
export async function purgeMemory(
  store: MemoryStore,
  axis: MemoryPurgeAxis,
  // Optional, matching `previewMemoryPurge` — the two share
  // `resolvePurgeTargets`, so a caller that may omit the selector for one
  // (`axis: 'all'` ignores it) must be able to omit it for the other. The
  // asymmetry made `purgeMemory(store, 'all')` a type error while
  // `previewMemoryPurge(store, 'all')` was fine, which is how the test tree
  // accumulated the errors the ratchet was tracking.
  selector?: string,
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
