/**
 * @omadia/usage-telemetry — LLM token-usage + cost capture and aggregation.
 *
 * Write path:  initUsageRecorder(pool) once → recordUsage(...) per call, or
 *              wrap an LlmProvider with withProviderUsageTracking(provider, {source}).
 * Read path:   getUsageDashboard(pool, window) for the cost dashboard.
 */
import type { SUBSCRIPTION_SOURCES } from './queries.js';

export {
  type ModelPrice,
  type UsageTokens,
  CACHE_READ_MULTIPLIER,
  CACHE_WRITE_MULTIPLIER,
  priceForModel,
  computeCostUsd,
  normalizeUsage,
} from './pricing.js';

export {
  type UsageRecord,
  initUsageRecorder,
  isUsageRecorderReady,
  recordUsage,
  flush as flushUsageRecorder,
  shutdownUsageRecorder,
} from './recorder.js';

export { withProviderUsageTracking } from './withProviderUsageTracking.js';

export {
  type UsageWindow,
  type UsageTotals,
  type UsageByKey,
  type UsageBucket,
  type UsageDashboard,
  SUBSCRIPTION_SOURCES,
  getUsageDashboard,
} from './queries.js';

/**
 * OM-103 — the two `source` values the subscription seams record under. They
 * are exactly {@link SUBSCRIPTION_SOURCES}, which is how the dashboard counts
 * subscription turns without guessing from the model name; the assignments
 * below keep the producers and that query in one file's view of each other.
 */
export const CLI_CHAT_USAGE_SOURCE: (typeof SUBSCRIPTION_SOURCES)[0] = 'claude-cli';
export const CLI_COMPLETION_USAGE_SOURCE: (typeof SUBSCRIPTION_SOURCES)[1] =
  'claude-cli-completion';
