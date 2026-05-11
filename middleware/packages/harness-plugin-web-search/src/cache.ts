/**
 * Tiny TTL+LRU cache for search responses. Bounded by entry count rather
 * than bytes — typical search responses are a few KB so a 200-entry cap is
 * about a megabyte of headroom in the worst case.
 *
 * Why not reuse a host-side cache? The plugin is shipped as its own package
 * so it stays portable; depending on a kernel cache would couple the plugin
 * to a kernel internal that doesn't exist as a stable surface today. A
 * future revision can swap to `ctx.services.get('cache')` once a generic
 * cache service lands.
 */

interface Entry<V> {
  value: V;
  expiresAt: number;
}

export class TtlLruCache<V> {
  private readonly map = new Map<string, Entry<V>>();

  constructor(
    private readonly maxEntries: number,
    private readonly defaultTtlMs: number,
  ) {
    if (maxEntries <= 0) {
      throw new Error('TtlLruCache: maxEntries must be positive');
    }
    if (defaultTtlMs <= 0) {
      throw new Error('TtlLruCache: defaultTtlMs must be positive');
    }
  }

  get(key: string, now: number = Date.now()): V | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= now) {
      this.map.delete(key);
      return undefined;
    }
    // Refresh LRU position — re-insert at the tail.
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(key: string, value: V, ttlMs?: number, now: number = Date.now()): void {
    const expiresAt = now + (ttlMs ?? this.defaultTtlMs);
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.maxEntries) {
      // Map iteration order is insertion order — oldest entry is first.
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(key, { value, expiresAt });
  }

  /** Drop all entries. Useful for tests and for manual config-change
   *  invalidation when the operator rotates an API key. */
  clear(): void {
    this.map.clear();
  }

  /** Approximate live entry count — counts entries whose TTL has not yet
   *  passed at `now`. O(n); intended for dashboards / tests, not hot path. */
  liveSize(now: number = Date.now()): number {
    let count = 0;
    for (const entry of this.map.values()) {
      if (entry.expiresAt > now) count++;
    }
    return count;
  }
}
