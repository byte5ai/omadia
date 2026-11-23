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
  hasKnownPrice,
  computeCostUsd,
  computeCacheSavingsUsd,
  normalizeUsage,
} from './pricing.js';

export {
  type UsageRecord,
  type UsageContext,
  initUsageRecorder,
  isUsageRecorderReady,
  recordUsage,
  providerRecordsOwnUsage,
  setUsageContextProvider,
  runWithUsageContext,
  flush as flushUsageRecorder,
  shutdownUsageRecorder,
} from './recorder.js';

export { withProviderUsageTracking } from './withProviderUsageTracking.js';
export { addMeteredCost, meterUsageCost } from './costMeter.js';

export { type FxRate, createEcbEurRateSource } from './exchangeRate.js';

export {
  type UsageWindow,
  type UsageTotals,
  type UsageByKey,
  type UsageBucket,
  type UsageDashboard,
  type UsageBucketSize,
  type UsageKeyGroup,
  SUBSCRIPTION_SOURCES,
  BUILDER_SOURCE_PREFIX,
  BUILDER_SOURCE_KEY,
  OTHER_SOURCE_KEY,
  BY_SOURCE_LIMIT,
  capByKey,
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

// #2090 — count and bound the model calls of an async scope: the host half of
// the provider contract's `admitModelCall` (`@omadia/llm-provider-api`).
// Spec 2042 §5.10 — the model gateway's execution contexts, mode and halts.
export {
  callSiteOf,
  currentExecutionContext,
  executionContextChain,
  installModelCallGate,
  meterModelCalls,
  modelCallHaltFor,
  modelGatewayMode,
  onUncoveredModelCall,
  resetModelGatewayForTests,
  runDetachedInExecutionContext,
  runInExecutionContext,
  runGeneratorInExecutionContext,
  runInExecutionContextSync,
  setAmbientExecutionContext,
  setModelCallHalts,
  setModelGatewayMode,
  uncoveredModelCalls,
  type ExecutionContextKind,
  type ModelCallCount,
  type ModelExecutionContext,
  type ModelGatewayMode,
  type UncoveredModelCall,
} from './modelCallMeter.js';
