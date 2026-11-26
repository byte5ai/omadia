import type { InstalledRegistry } from '../plugins/installedRegistry.js';
import {
  DEDUP_THRESHOLD_CONFIG_KEY,
  KG_NEON_ID,
  recommendedDedupThreshold,
} from './embeddingProviderCatalog.js';

/**
 * #1818 — the knowledge graph's `process_dedup_threshold`, with provenance.
 *
 * ADR-0080: a cosine threshold belongs to the model whose vector space it
 * scores, not to the knowledge graph. omadia writes an adapter's recommended
 * value into the KG config (the KG reads the plain key at activation). It used
 * to write that value as a bare string and then could not tell it apart from a
 * value the operator typed: the threshold of an uninstalled model stayed, a
 * switch never replaced it, and the Store form showed it as the operator's.
 *
 * THE MARKER. Next to the value omadia records which provider it recommended
 * the value for, under {@link DEDUP_THRESHOLD_SOURCE_CONFIG_KEY}. A value is
 * omadia's own exactly when the marker names a provider AND the stored value
 * is still that provider's recommendation. Any edit of the value through the
 * Store form (a shallow config merge, so the marker survives) makes the two
 * disagree, and from then on the value is the operator's and is never touched.
 * A changed compiled-in recommendation also reads as the operator's: unsure
 * means hands off.
 */

/** Kernel-synthetic KG config key (underscore prefix, like `_privacy_mode`):
 *  the provider whose recommendation the stored threshold is. */
export const DEDUP_THRESHOLD_SOURCE_CONFIG_KEY = '_process_dedup_threshold_recommended_by';

/** Where the stored threshold came from. */
export type DedupThresholdSource =
  /** No value stored: the knowledge graph's compiled-in default applies. */
  | 'default'
  /** omadia wrote it as the recommendation of `recommendedBy`. */
  | 'recommended'
  /** The operator set it (or it predates the marker). */
  | 'operator';

export interface DedupThresholdProvenance {
  readonly source: DedupThresholdSource;
  /** The stored value, `null` when unset. */
  readonly value: string | null;
  /** Provider the value was recommended for; only with `source: 'recommended'`. */
  readonly recommendedBy: string | null;
}

/** What a reconcile did. `applied` and `cleared` changed the config. */
export interface DedupThresholdOutcome {
  readonly applied: boolean;
  readonly value: number | null;
  readonly previous: string | null;
  readonly reason:
    | 'applied'
    /** omadia's own recommendation was removed; the KG default applies again. */
    | 'cleared'
    /** The recommendation for this provider is already in place. */
    | 'unchanged'
    /** The operator already put a value in the store — never overwritten. */
    | 'operator-set'
    /** This adapter makes no recommendation; the KG default stands. */
    | 'no-recommendation'
    /** No knowledge-graph installed, so there is nothing to configure. */
    | 'no-knowledge-graph';
}

function readText(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  // An empty string is the Store UI's way of spelling "not set".
  return text === '' ? null : text;
}

/** Provenance of the threshold in a KG config. */
export function describeDedupThreshold(
  config: Record<string, unknown>,
): DedupThresholdProvenance {
  const value = readText(config[DEDUP_THRESHOLD_CONFIG_KEY]);
  if (value === null) return { source: 'default', value: null, recommendedBy: null };
  const marker = readText(config[DEDUP_THRESHOLD_SOURCE_CONFIG_KEY]);
  if (marker !== null) {
    const recommended = recommendedDedupThreshold(marker);
    if (recommended !== null && String(recommended) === value) {
      return { source: 'recommended', value, recommendedBy: marker };
    }
  }
  return { source: 'operator', value, recommendedBy: null };
}

/** Provenance of the KG's threshold, `null` without a knowledge graph. */
export function readDedupThresholdProvenance(
  registry: InstalledRegistry,
): DedupThresholdProvenance | null {
  const entry = registry.get(KG_NEON_ID);
  return entry ? describeDedupThreshold(entry.config ?? {}) : null;
}

function withoutRecommendation(config: Record<string, unknown>): Record<string, unknown> {
  const next = { ...config };
  delete next[DEDUP_THRESHOLD_CONFIG_KEY];
  delete next[DEDUP_THRESHOLD_SOURCE_CONFIG_KEY];
  return next;
}

/**
 * Bring the threshold in line with the provider that now serves
 * `embeddingClient@1` (`/reactivate` and `/switch`).
 *
 * - operator value → untouched (a stale marker is dropped);
 * - unset or omadia's own → the provider's recommendation, with marker;
 * - provider without a recommendation → omadia's own value is removed, so the
 *   KG default applies again instead of another model's number.
 *
 * Like the plain key it writes, the result takes effect the next time the
 * knowledge-graph plugin activates (see `adminEmbeddingProvider.ts`).
 */
export async function reconcileRecommendedDedupThreshold(
  registry: InstalledRegistry,
  providerId: string,
): Promise<DedupThresholdOutcome> {
  const recommended = recommendedDedupThreshold(providerId);
  const entry = registry.get(KG_NEON_ID);
  if (!entry) {
    return { applied: false, value: recommended, previous: null, reason: 'no-knowledge-graph' };
  }
  const config = entry.config ?? {};
  const current = describeDedupThreshold(config);

  if (current.source === 'operator') {
    if (config[DEDUP_THRESHOLD_SOURCE_CONFIG_KEY] !== undefined) {
      const next = { ...config };
      delete next[DEDUP_THRESHOLD_SOURCE_CONFIG_KEY];
      await registry.register({ ...entry, config: next });
    }
    return { applied: false, value: recommended, previous: current.value, reason: 'operator-set' };
  }

  if (recommended === null) {
    if (current.source === 'recommended') {
      await registry.register({ ...entry, config: withoutRecommendation(config) });
      return { applied: false, value: null, previous: current.value, reason: 'cleared' };
    }
    return { applied: false, value: null, previous: null, reason: 'no-recommendation' };
  }

  if (current.source === 'recommended' && current.recommendedBy === providerId) {
    return { applied: false, value: recommended, previous: current.value, reason: 'unchanged' };
  }
  await registry.register({
    ...entry,
    config: {
      ...config,
      [DEDUP_THRESHOLD_CONFIG_KEY]: String(recommended),
      [DEDUP_THRESHOLD_SOURCE_CONFIG_KEY]: providerId,
    },
  });
  return { applied: true, value: recommended, previous: current.value, reason: 'applied' };
}

/**
 * The provider `providerId` was uninstalled: if the stored threshold is
 * omadia's recommendation FOR IT, remove it so the next KG activation uses the
 * default (or the next provider's recommendation, written on its reactivation
 * or switch). An operator value, or another provider's recommendation, stays.
 * Returns whether the config changed.
 */
export async function releaseRecommendedDedupThreshold(
  registry: InstalledRegistry,
  providerId: string,
): Promise<boolean> {
  const entry = registry.get(KG_NEON_ID);
  if (!entry) return false;
  const config = entry.config ?? {};
  const current = describeDedupThreshold(config);
  if (current.source !== 'recommended' || current.recommendedBy !== providerId) return false;
  await registry.register({ ...entry, config: withoutRecommendation(config) });
  return true;
}
