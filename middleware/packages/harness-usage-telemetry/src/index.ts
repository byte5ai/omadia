/**
 * @omadia/usage-telemetry — LLM token-usage + cost capture and aggregation.
 *
 * Write path:  initUsageRecorder(pool) once → recordUsage(...) per call, or
 *              wrap a client with withUsageTracking(client, {source}).
 * Read path:   getUsageDashboard(pool, window) for the cost dashboard.
 */
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

export {
  type UsageTrackingOptions,
  withUsageTracking,
} from './withUsageTracking.js';

export {
  type UsageWindow,
  type UsageTotals,
  type UsageByKey,
  type UsageBucket,
  type UsageDashboard,
  getUsageDashboard,
} from './queries.js';
