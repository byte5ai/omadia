/**
 * @omadia/usage-telemetry — LLM token-usage + cost capture and aggregation.
 *
 * Write path:  initUsageRecorder(pool) once → recordUsage(...) per call, or
 *              wrap an LlmProvider with withProviderUsageTracking(provider, {source}).
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

export { withProviderUsageTracking } from './withProviderUsageTracking.js';

// #584 — transcription-minute metering (sibling of the token recorder).
export {
  type TranscriptionUsageRecord,
  transcriptionPricePerMinuteUsd,
  computeTranscriptionCostUsd,
  initTranscriptionUsageRecorder,
  isTranscriptionUsageRecorderReady,
  recordTranscriptionUsage,
  flushTranscriptionUsage,
  shutdownTranscriptionUsageRecorder,
  sumTranscriptionBilledMinutesThisMonth,
} from './transcriptionUsage.js';

export {
  type UsageWindow,
  type UsageTotals,
  type UsageByKey,
  type UsageBucket,
  type UsageDashboard,
  getUsageDashboard,
} from './queries.js';
