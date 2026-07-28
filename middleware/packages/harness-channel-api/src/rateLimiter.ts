/**
 * Issue #438 — per-key rate limiting.
 *
 * Fixed-window token bucket, mirroring `middleware/src/platform/httpAccessor.ts`'s
 * `TokenBucket` (same "not wall-clock accurate, good enough to stop a runaway
 * caller" trade-off), but keyed per API key with a per-key configurable
 * capacity instead of one shared plugin-wide limit — the design decision on
 * issue #438 calls for per-key limits, not a single global one.
 *
 * In-memory, per-process. A restart clears every bucket; acceptable for v1
 * (a burst right after deploy is not the threat this defends against).
 */

const WINDOW_MS = 60_000;

class TokenBucket {
  private count = 0;
  private windowStart = Date.now();

  constructor(private readonly capacity: number) {}

  tryConsume(): boolean {
    const now = Date.now();
    if (now - this.windowStart >= WINDOW_MS) {
      this.count = 0;
      this.windowStart = now;
    }
    if (this.count >= this.capacity) return false;
    this.count++;
    return true;
  }
}

export interface RateLimiter {
  /** Returns `true` when the call is within budget (and consumes one unit
   *  of it), `false` when the key is over its per-minute limit. */
  tryConsume(keyId: string, capacityPerMinute: number): boolean;
}

export function createRateLimiter(): RateLimiter {
  const buckets = new Map<string, TokenBucket>();

  return {
    tryConsume(keyId, capacityPerMinute) {
      let bucket = buckets.get(keyId);
      // A key's configured limit can change between calls (revoke + recreate
      // reuses a fresh id, so this is really "first sight of this id"); pin
      // the bucket's capacity to what was configured when we first saw it.
      if (!bucket) {
        bucket = new TokenBucket(capacityPerMinute);
        buckets.set(keyId, bucket);
      }
      return bucket.tryConsume();
    },
  };
}
