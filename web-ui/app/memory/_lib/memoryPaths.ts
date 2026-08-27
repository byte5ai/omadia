import type { MemoryContextAxis } from '@/app/_lib/api';

/**
 * Path algebra for the scratch-memory browser.
 *
 * Physical layout per design #870 §2 (chat-context memory ACL):
 *
 *   /memories/orchestrators/<slug>/…            agent tier (pre-existing)
 *   /memories/contexts/<slug>/team/<ctxKey>/…   team tier
 *   /memories/contexts/<slug>/channel/<ctxKey>/… conversation tier
 *   /memories/contexts/<slug>/user/<ctxKey>/…   user tier
 *   /memories/core/… and the underscore roots    shared kernel/seed
 *
 * `contexts` is a NEW top-level segment precisely so no legacy
 * `orchestrator:<slug>:*` scope can reach a context tree and vice versa —
 * the browser mirrors that split instead of flattening it back together.
 *
 * All helpers here are pure so the tree/dialog components stay renderable
 * without a store; the fetching lives in `page.tsx`.
 */

export const MEMORY_ROOT = '/memories';
export const ORCHESTRATORS_ROOT = `${MEMORY_ROOT}/orchestrators`;
export const CONTEXTS_ROOT = `${MEMORY_ROOT}/contexts`;

/** Context axes, in the order the operator tree renders them. */
export const MEMORY_CONTEXT_AXES: readonly MemoryContextAxis[] = [
  'team',
  'channel',
  'user',
];

export function isMemoryContextAxis(v: string): v is MemoryContextAxis {
  return (MEMORY_CONTEXT_AXES as readonly string[]).includes(v);
}

/** A concrete context tree of one agent. */
export interface MemoryContextRef {
  readonly agentSlug: string;
  readonly axis: MemoryContextAxis;
  readonly ctxKey: string;
}

/** A path resolved inside a context tree. */
export interface MemoryContextLocation extends MemoryContextRef {
  /** Path relative to the tier root; '' when the path IS the tier root. */
  readonly relPath: string;
}

function segments(path: string): string[] {
  return path.split('/').filter((s) => s.length > 0);
}

export function agentTierRoot(agentSlug: string): string {
  return `${ORCHESTRATORS_ROOT}/${agentSlug}`;
}

export function contextAxisRoot(
  agentSlug: string,
  axis: MemoryContextAxis,
): string {
  return `${CONTEXTS_ROOT}/${agentSlug}/${axis}`;
}

export function contextTierRoot(ref: MemoryContextRef): string {
  return `${contextAxisRoot(ref.agentSlug, ref.axis)}/${ref.ctxKey}`;
}

/**
 * Resolve a physical `/memories/contexts/…` path into its context ref plus
 * the remainder relative to the tier root. Returns null for anything outside
 * a context tree (agent tier, core, seed) — the caller then knows the path is
 * not promotable, because promote sources are always a context tier (§6).
 */
export function parseContextPath(path: string): MemoryContextLocation | null {
  const segs = segments(path);
  const rootSegs = segments(CONTEXTS_ROOT);
  if (segs.length < rootSegs.length + 3) return null;
  for (const [i, expected] of rootSegs.entries()) {
    if (segs[i] !== expected) return null;
  }
  const agentSlug = segs[rootSegs.length];
  const axis = segs[rootSegs.length + 1];
  const ctxKey = segs[rootSegs.length + 2];
  if (
    agentSlug === undefined ||
    axis === undefined ||
    ctxKey === undefined ||
    !isMemoryContextAxis(axis)
  ) {
    return null;
  }
  return {
    agentSlug,
    axis,
    ctxKey,
    relPath: segs.slice(rootSegs.length + 3).join('/'),
  };
}

/**
 * Agent slug of a path inside the agent tier, or null when the path is not
 * under `/memories/orchestrators/<slug>`.
 */
export function parseAgentTierPath(path: string): string | null {
  const segs = segments(path);
  const rootSegs = segments(ORCHESTRATORS_ROOT);
  if (segs.length < rootSegs.length + 1) return null;
  for (const [i, expected] of rootSegs.entries()) {
    if (segs[i] !== expected) return null;
  }
  return segs[rootSegs.length] ?? null;
}

/**
 * Split a `<channelType>~<safeKey>` context key (design §3). `~` is outside
 * the safe alphabet, so the first `~` is the only separator and the split is
 * unambiguous. Returns null for keys that were not produced by
 * `memoryContextKey` (older data, hand-written paths).
 *
 * The second half is the `safeKey`, NOT the native id — it is a sanitised stem
 * plus a digest of the raw id, so it is deliberately not round-trippable back
 * into the platform's own id. Calling it `nativeId` invited a real mistake:
 * an operator reads `19-abc-thread-tacv2-a1b2c3d4` off a tree node, pastes it
 * into the Danger-Zone selector as "the raw native id", and the backend derives
 * a DIFFERENT key from it — a silent no-op on a destructive action. The full
 * `channelType~safeKey` (i.e. the key itself) is the form the selector accepts.
 */
export function decodeContextKey(
  ctxKey: string,
): { channelType: string; safeKey: string } | null {
  const idx = ctxKey.indexOf('~');
  if (idx <= 0 || idx === ctxKey.length - 1) return null;
  return {
    channelType: ctxKey.slice(0, idx),
    safeKey: ctxKey.slice(idx + 1),
  };
}

// --- generic browser path helpers -------------------------------------------

export function cwdToCrumbs(cwd: string): Array<{ path: string; label: string }> {
  if (cwd === MEMORY_ROOT) return [{ path: MEMORY_ROOT, label: 'memories' }];
  const crumbs: Array<{ path: string; label: string }> = [];
  let acc = '';
  for (const seg of segments(cwd)) {
    acc += `/${seg}`;
    crumbs.push({ path: acc, label: seg });
  }
  return crumbs;
}

export function parentOf(cwd: string): string | null {
  if (cwd === MEMORY_ROOT) return null;
  const idx = cwd.lastIndexOf('/');
  if (idx <= 0) return MEMORY_ROOT;
  return cwd.slice(0, idx) || MEMORY_ROOT;
}

export function basename(p: string): string {
  const idx = p.lastIndexOf('/');
  return idx === -1 ? p : p.slice(idx + 1);
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
