/**
 * #1033 W3 — per-provider health for the fallback path: a small circuit
 * breaker.
 *
 * Without it every turn during an outage first burns the primary's full
 * retry budget (5 SDK retries × backoff, ~30–40 s) before falling back. With
 * it, the first turn that trips the fallback marks the primary FAILED for a
 * cooldown; every turn inside that window routes straight to the fallback,
 * and the first turn after it probes the primary again. One entry per
 * provider id — an outage is a provider property, not a model or agent one.
 *
 * The clock is injectable so tests do not sleep.
 */

export const DEFAULT_PROVIDER_COOLDOWN_MS = 60_000;

export interface ProviderHealthEntry {
  readonly providerId: string;
  /** Epoch ms until which the provider is skipped in favour of its fallback. */
  readonly cooldownUntil: number;
  /** What tripped it — for the operator read-out. */
  readonly reason: string;
  readonly failedAt: number;
}

export interface ProviderHealth {
  /** `true` while the provider is inside its cooldown window. */
  inCooldown(providerId: string): boolean;
  /** Start (or extend) the cooldown after a fallback-worthy failure. */
  markFailed(providerId: string, reason: string): void;
  /** Clear the entry — a successful probe, or an operator override. */
  markHealthy(providerId: string): void;
  /** Every provider currently in cooldown, for `/admin/providers`. */
  snapshot(): readonly ProviderHealthEntry[];
}

export function createProviderHealth(opts: {
  cooldownMs?: number;
  now?: () => number;
} = {}): ProviderHealth {
  const cooldownMs = opts.cooldownMs ?? DEFAULT_PROVIDER_COOLDOWN_MS;
  const now = opts.now ?? (() => Date.now());
  const entries = new Map<string, ProviderHealthEntry>();

  const expire = (): void => {
    const t = now();
    for (const [id, e] of entries) if (e.cooldownUntil <= t) entries.delete(id);
  };

  return {
    inCooldown(providerId) {
      expire();
      return entries.has(providerId);
    },
    markFailed(providerId, reason) {
      const t = now();
      entries.set(providerId, {
        providerId,
        cooldownUntil: t + cooldownMs,
        reason,
        failedAt: t,
      });
    },
    markHealthy(providerId) {
      entries.delete(providerId);
    },
    snapshot() {
      expire();
      return [...entries.values()];
    },
  };
}
