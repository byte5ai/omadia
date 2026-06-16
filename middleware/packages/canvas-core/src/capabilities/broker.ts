/**
 * omadia-canvas-protocol/1.1 — capability broker egress bounds (lumens-spec.md §6).
 *
 * Because a capability call can be emitted from a `tick`/`timer`, Tier-2 bounds
 * EGRESS the way Tier-1 bounds compute (§0.2): per-capability rate + quota, a
 * max-in-flight ceiling, idempotent de-duplication of identical in-flight calls,
 * and backpressure when a broker saturates — so a ticking Lumen cannot move the
 * DoS/cost problem onto Tier-2/3. Pure and clock-injected (now passed in) so it
 * is deterministic and unit-testable.
 */
import type { CapabilityName } from './effects.js';

export interface CapLimits {
  /** max calls admitted per rolling window. */
  ratePerWindow: number;
  /** rolling window length in ms. */
  windowMs: number;
  /** total calls admitted over the Lumen's lifetime (cost ceiling). */
  quota: number;
  /** max concurrent in-flight calls. */
  maxInFlight: number;
}

export type AdmitResult =
  | { ok: true; deduped: false }
  | { ok: true; deduped: true } // identical call already in flight — coalesced
  | { ok: false; reason: 'rate' | 'quota' | 'backpressure' };

interface CapState {
  recent: number[]; // admit timestamps within the window
  used: number; // lifetime count
  inFlight: Map<string, number>; // idempotencyKey → refcount
}

/** Spike-tunable defaults (§14) — conservative; the real contract is a spike
 *  deliverable. Per-capability so an expensive cap (generateAsset) is tighter. */
export const DEFAULT_LIMITS: Record<CapabilityName, CapLimits> = {
  persist: { ratePerWindow: 20, windowMs: 1000, quota: 10_000, maxInFlight: 4 },
  loadData: { ratePerWindow: 20, windowMs: 1000, quota: 10_000, maxInFlight: 4 },
  writeData: { ratePerWindow: 5, windowMs: 1000, quota: 1_000, maxInFlight: 2 },
  tiles: { ratePerWindow: 30, windowMs: 1000, quota: 50_000, maxInFlight: 8 },
  fetch: { ratePerWindow: 5, windowMs: 1000, quota: 1_000, maxInFlight: 2 },
  generateAsset: { ratePerWindow: 2, windowMs: 1000, quota: 200, maxInFlight: 1 },
  clipboard: { ratePerWindow: 2, windowMs: 1000, quota: 100, maxInFlight: 1 },
  share: { ratePerWindow: 1, windowMs: 2000, quota: 50, maxInFlight: 1 },
  savePreset: { ratePerWindow: 1, windowMs: 2000, quota: 50, maxInFlight: 1 },
};

/** Per-Lumen broker limiter. One instance per Lumen instance; `admit`/`settle`
 *  bracket each brokered call. Idempotent de-dup coalesces identical in-flight
 *  calls (same cap + key) so a tick storm of identical requests is one call. */
export class BrokerLimiter {
  private readonly state = new Map<CapabilityName, CapState>();

  constructor(private readonly limits: Record<CapabilityName, CapLimits> = DEFAULT_LIMITS) {}

  private get(cap: CapabilityName): CapState {
    let s = this.state.get(cap);
    if (!s) {
      s = { recent: [], used: 0, inFlight: new Map() };
      this.state.set(cap, s);
    }
    return s;
  }

  /** Try to admit a call. `key` identifies an idempotent call for de-dup. */
  admit(cap: CapabilityName, key: string, now: number): AdmitResult {
    const limit = this.limits[cap];
    const s = this.get(cap);

    // identical call already in flight ⇒ coalesce (does not consume rate/quota).
    if (s.inFlight.has(key)) {
      s.inFlight.set(key, s.inFlight.get(key)! + 1);
      return { ok: true, deduped: true };
    }
    // backpressure: too many distinct calls in flight.
    if (s.inFlight.size >= limit.maxInFlight) return { ok: false, reason: 'backpressure' };
    // lifetime quota.
    if (s.used >= limit.quota) return { ok: false, reason: 'quota' };
    // rolling-window rate.
    s.recent = s.recent.filter((t) => now - t < limit.windowMs);
    if (s.recent.length >= limit.ratePerWindow) return { ok: false, reason: 'rate' };

    s.recent.push(now);
    s.used += 1;
    s.inFlight.set(key, 1);
    return { ok: true, deduped: false };
  }

  /** Mark a call (and any coalesced duplicates) complete, freeing in-flight slots. */
  settle(cap: CapabilityName, key: string): void {
    const s = this.state.get(cap);
    if (!s) return;
    s.inFlight.delete(key);
  }

  /** Remaining lifetime quota for a capability. */
  remaining(cap: CapabilityName): number {
    return Math.max(0, this.limits[cap].quota - (this.state.get(cap)?.used ?? 0));
  }
}
