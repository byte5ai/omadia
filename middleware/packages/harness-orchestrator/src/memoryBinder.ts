import {
  CONTEXT_FREE_MEMORY_AXES,
  memoryAxesForOrigin,
  teamAxisKey,
  type MemoryAxes,
  type TurnOrigin,
} from '@omadia/channel-sdk';
import { MemoryToolHandler } from '@omadia/memory';
import type { MemoryStore } from '@omadia/plugin-api';

import {
  DurableRulesMemoryStore,
  type DurableRulesHookDeps,
} from './durableRulesMemoryStore.js';
import {
  ContextMemoryNamespacer,
  OrchestratorMemoryNamespacer,
} from './orchestratorMemoryNamespacer.js';
import {
  contextTierRoot,
  effectiveMemoryScope,
  ScopedMemoryStore,
  type ContextMemoryEnforcement,
} from './registry/scopedMemoryStore.js';

/**
 * `MemoryBinder` (W5, design spec #870 §4/§5).
 *
 * Today an Agent gets ONE memory stack at build time, so everything it notes
 * through the `memory` tool lands in one agent-global tree — and is quotable in
 * every other chat the same Agent serves. The binder replaces that single stack
 * with one stack PER CHAT CONTEXT, resolved at the start of each turn from the
 * turn's `TurnOrigin`:
 *
 *   forOrigin(origin)
 *     → axes   = memoryAxesForOrigin(origin)                    (pure, §2 table)
 *     → scope  = effectiveMemoryScope(agentSlug, axes)          (static ∩ dynamic)
 *     → stack  = DurableRulesMemoryStore?( ContextMemoryNamespacer(
 *                  ScopedMemoryStore(scope, rootStore) ) )
 *
 * Four properties are load-bearing:
 *
 *  - **Synchronous.** The result is handed through the turn state explicitly
 *    rather than carried in async-local storage, so losing the context is a
 *    structural impossibility rather than an unlikely accident.
 *  - **Fail-closed.** No origin, a machine scope or an unresolvable one yields
 *    `['core', 'orchestrator:<slug>:*']` — byte-identical to today's stack, via
 *    today's `OrchestratorMemoryNamespacer`.
 *  - **Rollout-gated.** `mode: 'off'` short-circuits to the context-free stack
 *    for EVERY origin, so an operator can ship this wave dark. `'off'` is a
 *    routing decision and lives here, not as a second fail-open branch inside
 *    `effectiveMemoryScope`.
 *  - **Cached.** A stack is pure configuration over the shared root store, so
 *    identical axes reuse one instance. The cache is an LRU keyed by the
 *    canonical scope string: a busy Agent in hundreds of channels keeps a
 *    bounded number of wrappers alive, and eviction is never observable
 *    (evicting only drops the wrapper, never the data underneath).
 *
 * The root store is passed UNDECORATED (`deps.memoryStore`): the binder owns
 * the whole decorator chain. `ChatSessionStore`/`SessionLogger` deliberately
 * keep using the static agent-scoped store — session transcripts stay shared
 * under `core/sessions` (decision A3a).
 */

/** Default LRU capacity — see `MemoryBinderOptions.cacheCap`. */
export const DEFAULT_BINDER_CACHE_CAP = 256;

/**
 * Per-agent rollout switch for context-scoped memory.
 *
 * `'off'` is the first-release default and means byte-identical-to-today: every
 * turn, with or without an `origin`, gets the agent-private stack.
 */
export type ContextMemoryMode = 'off' | ContextMemoryEnforcement;

/** One turn's bound memory stack. */
export interface BoundTurnMemory {
  /** The model-facing `memory` tool handler for this turn. */
  readonly handler: MemoryToolHandler;
  /**
   * The store the handler runs on. Additive to the design's shape so callers
   * that need store-level access (tests, the promote service, purge previews)
   * do not have to re-derive the stack.
   */
  readonly store: MemoryStore;
  /** The compiled scope this stack enforces. */
  readonly scope: readonly string[];
  /** The axes this stack was built from. */
  readonly axes: MemoryAxes;
}

export interface MemoryBinderOptions {
  readonly agentSlug: string;
  /** The kernel `MemoryStore`, undecorated. */
  readonly root: MemoryStore;
  /** Durable-rules live hook, when the graph pool is available. */
  readonly durableRules?: DurableRulesHookDeps;
  /** LRU capacity; defaults to {@link DEFAULT_BINDER_CACHE_CAP}. */
  readonly cacheCap?: number;
  /** Rollout switch; defaults to `'off'` (today's behaviour). */
  readonly mode?: ContextMemoryMode;
  /** Warn sink, forwarded to every `ScopedMemoryStore` this binder builds. */
  readonly log?: (msg: string, fields?: Record<string, unknown>) => void;
}

/**
 * Separator for the binder's LRU key.
 *
 * U+001F (UNIT SEPARATOR) rather than a raw NUL: it cannot occur in a slug, an
 * axis name or a context key either — `memoryContextKey` emits only
 * `[a-z0-9_~-]` — but a NUL byte in the source would make git classify this
 * file as binary, which is exactly the wrong property for the most
 * security-critical file in the wave.
 */
const CACHE_KEY_SEP = '\u001f';

/**
 * The binder's LRU key. Exported because "the key does not collide between
 * agents or axes" is a property worth asserting directly rather than inferring
 * from cache hit counts.
 */
export function memoryBindingCacheKey(
  agentSlug: string,
  axes: MemoryAxes,
  mode: ContextMemoryMode = 'off',
): string {
  const narrowest = axes.narrowest
    ? `${axes.narrowest.axis}${CACHE_KEY_SEP}${axes.narrowest.ctxKey}`
    : '';
  const scope =
    mode === 'off'
      ? []
      : effectiveMemoryScope(agentSlug, axes, { mode });
  return [agentSlug, mode, narrowest, ...scope].join(CACHE_KEY_SEP);
}

export class MemoryBinder {
  private readonly cacheCap: number;
  private readonly mode: ContextMemoryMode;
  /** Insertion-ordered — `Map` iteration order is the LRU order. */
  private readonly cache = new Map<string, BoundTurnMemory>();

  constructor(private readonly options: MemoryBinderOptions) {
    const cap = options.cacheCap ?? DEFAULT_BINDER_CACHE_CAP;
    this.cacheCap = cap > 0 ? Math.floor(cap) : DEFAULT_BINDER_CACHE_CAP;
    this.mode = options.mode ?? 'off';
  }

  /**
   * The rollout mode this binder enforces. Read by the orchestrator so the
   * recall paths outside the memory tree (graph recall, `query_knowledge_graph`)
   * apply the same `enforce-strict` boundary the tree does.
   */
  get contextMemoryMode(): ContextMemoryMode {
    return this.mode;
  }

  /** Live cache size. Bounded by `cacheCap`. */
  get cacheSize(): number {
    return this.cache.size;
  }

  /**
   * Resolve the memory stack for one turn. Synchronous and cached; the same
   * origin always yields the same instance until it is evicted.
   */
  forOrigin(origin: TurnOrigin | undefined): BoundTurnMemory {
    // `'off'` discards the origin entirely rather than resolving axes and then
    // ignoring them — one branch, so there is no path on which a half-applied
    // rollout could still open a context tree.
    const axes =
      this.mode === 'off'
        ? CONTEXT_FREE_MEMORY_AXES
        : memoryAxesForOrigin(origin);
    const key = memoryBindingCacheKey(this.options.agentSlug, axes, this.mode);

    const hit = this.cache.get(key);
    if (hit) {
      // Refresh recency: delete + set moves the entry to the end of the
      // insertion order, which is what makes eviction least-recently-USED
      // rather than least-recently-added.
      this.cache.delete(key);
      this.cache.set(key, hit);
      return hit;
    }

    const bound = this.build(axes);
    this.cache.set(key, bound);
    this.evictOverflow();
    return bound;
  }

  private evictOverflow(): void {
    while (this.cache.size > this.cacheCap) {
      const oldest = this.cache.keys().next();
      if (oldest.done) return;
      this.cache.delete(oldest.value);
    }
  }

  private build(axes: MemoryAxes): BoundTurnMemory {
    const { agentSlug, root, durableRules, log } = this.options;
    const scope =
      this.mode === 'off'
        ? effectiveMemoryScope(agentSlug, CONTEXT_FREE_MEMORY_AXES)
        : effectiveMemoryScope(agentSlug, axes, {
            mode: this.mode,
            ...(log ? { log } : {}),
          });

    const scoped = new ScopedMemoryStore({
      agentSlug,
      scope,
      inner: root,
      ...(log ? { log } : {}),
    });

    const namespaced: MemoryStore =
      axes.isContextFree || !axes.narrowest
        ? new OrchestratorMemoryNamespacer(agentSlug, scoped)
        : new ContextMemoryNamespacer(
            {
              privateRoot: contextTierRoot(
                agentSlug,
                axes.narrowest.axis,
                axes.narrowest.ctxKey,
              ),
              agentRoot: `/memories/orchestrators/${agentSlug}`,
              ...this.teamRootFor(axes),
            },
            scoped,
          );

    // Durable-rules decorator stays OUTSIDE the namespacer so it still sees the
    // model-facing `_rules/` path (both namespacers pass `_` segments through).
    const store: MemoryStore = durableRules
      ? new DurableRulesMemoryStore(namespaced, durableRules)
      : namespaced;

    return { handler: new MemoryToolHandler(store), store, scope, axes };
  }

  private teamRootFor(axes: MemoryAxes): { teamRoot?: string } {
    const key = teamAxisKey(axes);
    if (key === undefined) return {};
    return { teamRoot: contextTierRoot(this.options.agentSlug, 'team', key) };
  }
}
