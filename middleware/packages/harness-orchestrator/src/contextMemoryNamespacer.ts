import type { MemoryEntry, MemoryStore } from '@omadia/plugin-api';

import { contextTierRoot } from './registry/scopedMemoryStore.js';

/**
 * Per-chat-context memory namespacer (W5, design spec #870 §4).
 *
 * The sibling `OrchestratorMemoryNamespacer` gives every Agent a private
 * `/memories` root backed by `/memories/orchestrators/<slug>/…`. This variant
 * does the same job for ONE chat context: the model's plain `/memories/<x>`
 * lands in the narrowest tier of the turn (the channel tree, or the user tree
 * in a personal chat), so a model that knows nothing about contexts still
 * writes context-local notes.
 *
 * Two reserved model-facing segments open the wider tiers explicitly:
 *
 *   /memories/~team/…   → /memories/contexts/<slug>/team/<teamKey>/…
 *   /memories/~agent/…  → /memories/orchestrators/<slug>/…      (read-only)
 *
 * `~` is the right marker because the existing namespacer never emits a `~`
 * segment outward, so the reserved names cannot collide with any pre-existing
 * path. Read-only-ness of `~agent` is NOT enforced here — the mapper only
 * rewrites; the `ScopedMemoryStore` underneath holds `ro:orchestrator:<slug>:*`
 * and turns a write into a `MemoryScopeViolation`. Keeping enforcement in one
 * layer is what preserves the documented backstop guarantee: a rewrite bug
 * surfaces as a violation, never as a leak.
 *
 * When the turn has no team axis, `~team` is mapped to a deterministic root
 * that no scope ever grants (`…/team/<UNBOUND_TEAM_KEY>`), so the attempt fails
 * closed through the same backstop instead of being silently redirected into
 * the private tree.
 *
 * Layering (built by `MemoryBinder`):
 *   DurableRulesMemoryStore?    (shared `_rules/` passthrough, unchanged)
 *     → ContextMemoryNamespacer (this)
 *       → ScopedMemoryStore     (core + ro:orchestrator:<slug>:* + context tiers)
 *         → root MemoryStore    (physical I/O)
 */

const MEMORIES_ROOT = '/memories';

/**
 * Shared first segments that pass through untouched — identical to
 * `OrchestratorMemoryNamespacer`, so `core`, session transcripts and the
 * durable-rules `_rules/` tree behave the same inside a context turn.
 */
const SHARED_SEGMENTS = new Set(['core', 'sessions', 'chat-sessions']);

/** Reserved model-facing segment for the team tier. */
export const TEAM_SEGMENT = '~team';
/** Reserved model-facing segment for the agent-global (legacy) tier. */
export const AGENT_SEGMENT = '~agent';

/**
 * The team key used when a turn addresses `~team` without holding a team axis.
 * A real key always contains `~` (see `memoryContextKey`), so this literal can
 * never be granted by an actual context.
 */
const UNBOUND_TEAM_KEY = '__unbound__';

function firstSegment(rest: string): string {
  const trimmed = rest.replace(/^\/+/, '');
  const slash = trimmed.indexOf('/');
  return slash === -1 ? trimmed : trimmed.slice(0, slash);
}

function isShared(segment: string): boolean {
  return segment.startsWith('_') || SHARED_SEGMENTS.has(segment);
}

export interface ContextMemoryNamespacerOptions {
  readonly agentSlug: string;
  /** Physical root of the narrowest tier — where plain `/memories/<x>` lands. */
  readonly privateRoot: string;
  /** Physical root of the team tier, when the turn holds a team axis. */
  readonly teamRoot?: string;
}

export class ContextMemoryNamespacer implements MemoryStore {
  private readonly privateRoot: string;
  private readonly agentRoot: string;
  private readonly teamRoot: string;
  /** Physical root → model-facing root, longest physical root first. */
  private readonly outward: ReadonlyArray<readonly [string, string]>;

  constructor(
    options: ContextMemoryNamespacerOptions,
    private readonly inner: MemoryStore,
  ) {
    this.privateRoot = options.privateRoot;
    this.agentRoot = `${MEMORIES_ROOT}/orchestrators/${options.agentSlug}`;
    this.teamRoot =
      options.teamRoot ?? contextTierRoot(options.agentSlug, 'team', UNBOUND_TEAM_KEY);
    this.outward = [
      [this.teamRoot, `${MEMORIES_ROOT}/${TEAM_SEGMENT}`],
      [this.agentRoot, `${MEMORIES_ROOT}/${AGENT_SEGMENT}`],
      [this.privateRoot, MEMORIES_ROOT],
    ];
  }

  /** Model-facing `/memories/...` → physical path. */
  private toInner(path: string): string {
    if (path === MEMORIES_ROOT) return this.privateRoot;
    if (!path.startsWith(`${MEMORIES_ROOT}/`)) return path; // not ours; leave it

    const rest = path.slice(MEMORIES_ROOT.length); // '/...'
    const segment = firstSegment(rest);
    if (isShared(segment)) return path; // shared namespace — passthrough
    if (segment === TEAM_SEGMENT) {
      return `${this.teamRoot}${rest.slice(TEAM_SEGMENT.length + 1)}`;
    }
    if (segment === AGENT_SEGMENT) {
      return `${this.agentRoot}${rest.slice(AGENT_SEGMENT.length + 1)}`;
    }
    return `${this.privateRoot}${rest}`;
  }

  /** Physical path → model-facing `/memories/...` (inverse of `toInner`). */
  private toOuter(path: string): string {
    for (const [physical, facing] of this.outward) {
      if (path === physical) return facing;
      if (path.startsWith(`${physical}/`)) {
        return `${facing}${path.slice(physical.length)}`;
      }
    }
    return path; // shared / unmapped — already in the outer namespace
  }

  list(virtualPath: string): Promise<MemoryEntry[]> {
    return this.inner
      .list(this.toInner(virtualPath))
      .then((entries) => entries.map((e) => ({ ...e, virtualPath: this.toOuter(e.virtualPath) })));
  }

  fileExists(virtualPath: string): Promise<boolean> {
    return this.inner.fileExists(this.toInner(virtualPath));
  }

  directoryExists(virtualPath: string): Promise<boolean> {
    return this.inner.directoryExists(this.toInner(virtualPath));
  }

  readFile(virtualPath: string): Promise<string> {
    return this.inner.readFile(this.toInner(virtualPath));
  }

  createFile(virtualPath: string, content: string): Promise<void> {
    return this.inner.createFile(this.toInner(virtualPath), content);
  }

  writeFile(virtualPath: string, content: string): Promise<void> {
    return this.inner.writeFile(this.toInner(virtualPath), content);
  }

  delete(virtualPath: string): Promise<void> {
    return this.inner.delete(this.toInner(virtualPath));
  }

  rename(fromVirtualPath: string, toVirtualPath: string): Promise<void> {
    return this.inner.rename(this.toInner(fromVirtualPath), this.toInner(toVirtualPath));
  }
}
