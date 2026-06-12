/**
 * #133 — a tiny per-scope TTL cache for the dev graph `/plans` overlay.
 *
 * The plan overlay is an inspection view (the live chat UI gets plan progress
 * from the turn stream, not this REST endpoint), so a short TTL is the right
 * trade-off: it collapses repeated `/plans?scope=` reads — the WebUI refetches
 * on every Pläne-toggle and session switch — to one knowledge-graph round-trip
 * per window, while a few-second TTL keeps a freshly-advanced step visible.
 *
 * Pure and clock-injectable (`now`) so the TTL/invalidation behaviour is
 * unit-testable without real time. `invalidate()` is exposed for callers that
 * can observe a plan write and want zero staleness.
 */

export interface PlanScopeCacheOptions {
  /** Entry lifetime in ms. Default 2000 — short, because the overlay is live. */
  ttlMs?: number;
  /** Clock source; injected in tests. Default `Date.now`. */
  now?: () => number;
}

export class PlanScopeCache<T> {
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly entries = new Map<string, { value: T; expiresAt: number }>();

  constructor(opts: PlanScopeCacheOptions = {}) {
    this.ttlMs = opts.ttlMs ?? 2000;
    this.now = opts.now ?? ((): number => Date.now());
  }

  /** Return the cached value for `scope`, or undefined when absent/expired.
   *  An expired entry is evicted on read so the map can't grow unboundedly. */
  get(scope: string): T | undefined {
    const hit = this.entries.get(scope);
    if (!hit) return undefined;
    if (this.now() >= hit.expiresAt) {
      this.entries.delete(scope);
      return undefined;
    }
    return hit.value;
  }

  /** Cache `value` for `scope`, expiring `ttlMs` from now. */
  set(scope: string, value: T): void {
    this.entries.set(scope, { value, expiresAt: this.now() + this.ttlMs });
  }

  /** Drop one scope's entry, or the whole cache when `scope` is omitted. */
  invalidate(scope?: string): void {
    if (scope === undefined) this.entries.clear();
    else this.entries.delete(scope);
  }

  /** Live entry count (after no eviction) — for tests/diagnostics. */
  get size(): number {
    return this.entries.size;
  }
}
