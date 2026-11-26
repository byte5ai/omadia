/**
 * Per-key rate limiting. Introduced by issue #438 inside
 * `@omadia/channel-api`, moved here unchanged by issue #439.
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

  /** `capacity` is read on every call, not pinned at creation: an operator
   *  who changes a limit expects it to apply to the next call (#1935), and the
   *  refusal message already quotes the current value. Units consumed in the
   *  current window stay counted, so lowering a limit mid-window refuses at
   *  once and raising it frees the difference. */
  tryConsume(capacity: number): boolean {
    const now = Date.now();
    if (now - this.windowStart >= WINDOW_MS) {
      this.count = 0;
      this.windowStart = now;
    }
    if (this.count >= capacity) return false;
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
      if (!bucket) {
        bucket = new TokenBucket();
        buckets.set(keyId, bucket);
      }
      return bucket.tryConsume(capacityPerMinute);
    },
  };
}
