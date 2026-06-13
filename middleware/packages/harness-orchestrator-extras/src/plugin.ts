import type { LlmProvider } from '@omadia/llm-provider';
import {
  createAnthropicClient,
  createAnthropicProvider,
  readProviderApiKey,
} from '@omadia/llm-provider';
import type { PluginContext } from '@omadia/plugin-api';
import type { EmbeddingClient } from '@omadia/embeddings';
import type {
  AgentPrioritiesStore,
  KnowledgeGraph,
  NudgeProvider,
  ProcessMemoryService,
  Visibility,
} from '@omadia/plugin-api';
import {
  BULK_EXCERPT_MERGE_DETECT_SERVICE_NAME,
  BULK_INCONSISTENCY_SERVICE_NAME,
  BULK_MERGE_DETECT_SERVICE_NAME,
  BULK_PROMOTION_SERVICE_NAME,
  INCONSISTENCY_DETECTOR_SERVICE_NAME,
  MERGE_CANDIDATE_DETECTOR_SERVICE_NAME,
  NUDGE_PROVIDERS_SERVICE_NAME,
  PALAIA_EXCERPT_SERVICE_NAME,
  PROCESS_MEMORY_SERVICE_NAME,
  TOPIC_CLUSTERING_SERVICE_NAME,
} from '@omadia/plugin-api';

import {
  CaptureFilter,
  type CaptureLevel,
  defaultThresholdForLevel,
} from './captureFilter.js';
import { CaptureFilteringKnowledgeGraph } from './captureFilteringKnowledgeGraph.js';
import { ContextRetriever } from './contextRetriever.js';
import type { Pool } from 'pg';
import {
  initUsageRecorder,
  withProviderUsageTracking,
} from '@omadia/usage-telemetry';

import { createBulkExcerptMergeDetectService } from './bulkExcerptMergeDetect.js';
import { createBulkInconsistencyService } from './bulkInconsistency.js';
import { createBulkMergeDetectService } from './bulkMergeDetect.js';
import { createBulkPromotionService } from './bulkPromotion.js';
import { createMergeCandidateDetector } from './mergeCandidateDetector.js';
import { MergeTriggeringKnowledgeGraph } from './mergeTriggeringKnowledgeGraph.js';
import { createTopicClusteringService } from './topicClustering.js';
import { createHaikuPalaiaExcerptExtractor } from './excerptExtractor.js';
import { createInconsistencyDetector } from './inconsistencyDetector.js';
import { InconsistencyTriggeringKnowledgeGraph } from './inconsistencyTriggeringKnowledgeGraph.js';
import { FactExtractor } from './factExtractor.js';
import { createHaikuSessionSummaryGenerator } from './sessionSummaryGenerator.js';
import { createSessionBriefingService } from './sessionBriefing.js';
import { createHaikuSignificanceScorer } from './significanceScorer.js';
import { createScratchPromotionReaper } from './scratchPromotionReaper.js';
import { TopicDetector } from './topicDetector.js';
import { ProcessPromoteProvider } from './nudgeProviders/processPromote.js';

/**
 * @omadia/orchestrator-extras — plugin entry point.
 *
 * **S+9.2 Sub-Commit 2b: capability lifetime flipped.** activate() now
 * constructs the four tool-set classes against the live capabilities
 * (`knowledgeGraph`, `embeddingClient`, `memoryStore`) and publishes
 * three service capabilities (`contextRetriever@1`, `factExtractor@1`,
 * `topicDetector@1`). Consumers (Orchestrator, Teams channel) declare
 * `requires:` and pick them up via `ctx.services.get`. The pre-2b
 * kernel-side construction in `src/index.ts` is gone.
 *
 * Config (via ctx.config, seeded by `bootstrapOrchestratorExtrasFromEnv`
 * from the legacy ANTHROPIC_API_KEY / TOPIC_* .env vars):
 *   - `anthropic_api_key`        optional → FactExtractor + TopicDetector
 *                                only constructed when set
 *   - `fact_extractor_model`     default 'claude-haiku-4-5-20251001'
 *   - `topic_classifier_model`   default 'claude-haiku-4-5-20251001'
 *   - `topic_upper_threshold`    default 0.55
 *   - `topic_lower_threshold`    default 0.15
 *
 * Graceful degradation rules:
 *   - Missing knowledgeGraph capability → plugin activates but publishes
 *     nothing; consumers degrade.
 *   - Missing Anthropic key → ContextRetriever still published;
 *     FactExtractor + TopicDetector skipped.
 *
 * Note: `graphBackfill` lives in this package's barrel export (it's the
 * historical session-transcript replay) but the kernel still calls it
 * directly during boot — it's a kernel-orchestration concern, not a
 * plugin-activation one (the 88-turn replay routinely exceeds the 10s
 * activate-timeout).
 */

const CONTEXT_RETRIEVER_SERVICE = 'contextRetriever';
const FACT_EXTRACTOR_SERVICE = 'factExtractor';
const SESSION_BRIEFING_SERVICE = 'sessionBriefing';
const TOPIC_DETECTOR_SERVICE = 'topicDetector';
const KNOWLEDGE_GRAPH_SERVICE = 'knowledgeGraph';
const CAPTURE_FILTER_SERVICE = 'captureFilter';

const DEFAULT_HAIKU_MODEL = 'claude-haiku-4-5-20251001';
const DEFAULT_TOPIC_UPPER = 0.55;
const DEFAULT_TOPIC_LOWER = 0.15;
// Default `normal`: the capture-filter scores each turn's significance so
// auto-promotion (now on by default) has a signal to gate on. Costs a Haiku
// call per captured turn — set `capture_level=minimal` (scorer off) to avoid
// that spend. Requires an Anthropic key; without one the scorer stays
// disabled regardless of level.
const DEFAULT_CAPTURE_LEVEL: CaptureLevel = 'normal';
const DEFAULT_CAPTURE_VISIBILITY: Visibility = 'team';

export interface OrchestratorExtrasPluginHandle {
  close(): Promise<void>;
}

export async function activate(
  ctx: PluginContext,
): Promise<OrchestratorExtrasPluginHandle> {
  const knowledgeGraph =
    ctx.services.get<KnowledgeGraph>('knowledgeGraph');
  const embeddingClient =
    ctx.services.get<EmbeddingClient>('embeddingClient');
  // OB-74 (Palaia Phase 5) — optional capability. When the KG provider
  // doesn't publish it (e.g. in-memory backend, migration not yet applied)
  // the assembler degrades to manual-boost only without per-agent block/boost.
  const agentPriorities =
    ctx.services.get<AgentPrioritiesStore>('agentPriorities');

  if (!knowledgeGraph) {
    ctx.log(
      '[harness-orchestrator-extras] knowledgeGraph capability missing — plugin active but no services published',
    );
    return {
      async close(): Promise<void> {
        ctx.log('[harness-orchestrator-extras] deactivating (no-op activation)');
      },
    };
  }

  // anthropic_api_key is vault-stored. Read the provider-namespaced canonical
  // key (provider:anthropic/api_key) with a fallback to the legacy flat key, so
  // pre-migration installs keep working (phase 4 credential scheme).
  const apiKey =
    (await readProviderApiKey((k) => ctx.secrets.get(k), 'anthropic')) ?? '';
  const factModel =
    (ctx.config.get<string>('fact_extractor_model') ?? '').trim() ||
    DEFAULT_HAIKU_MODEL;
  const classifierModel =
    (ctx.config.get<string>('topic_classifier_model') ?? '').trim() ||
    DEFAULT_HAIKU_MODEL;
  const upperThreshold = parseNumberOrDefault(
    ctx.config.get<unknown>('topic_upper_threshold'),
    DEFAULT_TOPIC_UPPER,
  );
  const lowerThreshold = parseNumberOrDefault(
    ctx.config.get<unknown>('topic_lower_threshold'),
    DEFAULT_TOPIC_LOWER,
  );

  // OB-72 (Phase 3) — hybrid-retrieval knobs. Defaults preserve pre-OB-72
  // behaviour (min-score 0, recency 0.05/d, neutral type-weights) so a
  // workspace that never visits the setup wizard still sees the same hits.
  const recallMinScore = parseNumberOrDefault(
    ctx.config.get<unknown>('recall_min_score'),
    0,
  );
  const recallRecencyBoost = parseNumberOrDefault(
    ctx.config.get<unknown>('recall_recency_boost'),
    0.05,
  );
  const recallTypeWeights = {
    memory: parseNumberOrDefault(
      ctx.config.get<unknown>('recall_type_weight_memory'),
      1.0,
    ),
    process: parseNumberOrDefault(
      ctx.config.get<unknown>('recall_type_weight_process'),
      1.0,
    ),
    task: parseNumberOrDefault(
      ctx.config.get<unknown>('recall_type_weight_task'),
      1.0,
    ),
  };

  // OB-74 (Palaia Phase 5) — Token-Budget-Assembler tuning knobs.
  const contextDefaultBudgetTokens = parseNumberOrDefault(
    ctx.config.get<unknown>('context_default_budget_tokens'),
    6_000,
  );
  const contextCharsPerToken = parseNumberOrDefault(
    ctx.config.get<unknown>('context_chars_per_token'),
    4,
  );
  const contextManualBoostFactor = parseNumberOrDefault(
    ctx.config.get<unknown>('context_manual_boost_factor'),
    1.3,
  );
  const contextCompactModeThreshold = parseNumberOrDefault(
    ctx.config.get<unknown>('context_compact_mode_threshold'),
    100,
  );

  // Slice 7 — memory-recall toggle + tuning. Default ON whenever an
  // embeddingClient is wired (we still skip the leg in `loadMemoryHits`
  // when no userId is present). Set KG_ACL_MEMORY_RECALL_ENABLED=false
  // (or config key kg_acl_memory_recall_enabled=false) to A/B without
  // a code change.
  const memoryRecallEnabledRaw =
    ctx.config.get<unknown>('kg_acl_memory_recall_enabled') ??
    process.env['KG_ACL_MEMORY_RECALL_ENABLED'];
  const memoryRecallDisabled =
    typeof memoryRecallEnabledRaw === 'string'
      ? memoryRecallEnabledRaw.toLowerCase() === 'false'
      : memoryRecallEnabledRaw === false;
  const memoryLimit = parseNumberOrDefault(
    ctx.config.get<unknown>('kg_acl_memory_recall_limit'),
    3,
  );
  const memoryExcerptsPerMemory = parseNumberOrDefault(
    ctx.config.get<unknown>('kg_acl_memory_recall_excerpts_per_memory'),
    2,
  );
  const memoryMinSimilarity = parseNumberOrDefault(
    ctx.config.get<unknown>('kg_acl_memory_recall_min_similarity'),
    0.5,
  );
  const memoryBoostFactor = parseNumberOrDefault(
    ctx.config.get<unknown>('kg_acl_memory_recall_boost_factor'),
    1.2,
  );

  // Cross-session recall probe — Plan + Process recall + team-scoped
  // insights. `teamVisibility` defaults ON (operator-chosen team scope):
  // the memory-recall leg then admits `team`/`public` MemorableKnowledge
  // tenant-wide, not just rows the viewer owns. Set
  // kg_recall_team_visibility=false (or env KG_RECALL_TEAM_VISIBILITY=false)
  // to revert to owner-only. Plan + process legs default ON; disable with
  // kg_recall_plan_enabled=false / kg_recall_process_enabled=false.
  const teamVisibilityRaw =
    ctx.config.get<unknown>('kg_recall_team_visibility') ??
    process.env['KG_RECALL_TEAM_VISIBILITY'];
  const teamVisibility =
    typeof teamVisibilityRaw === 'string'
      ? teamVisibilityRaw.toLowerCase() !== 'false'
      : teamVisibilityRaw !== false;
  const planRecallEnabledRaw =
    ctx.config.get<unknown>('kg_recall_plan_enabled') ??
    process.env['KG_RECALL_PLAN_ENABLED'];
  const planRecallDisabled =
    typeof planRecallEnabledRaw === 'string'
      ? planRecallEnabledRaw.toLowerCase() === 'false'
      : planRecallEnabledRaw === false;
  const planLimit = parseNumberOrDefault(
    ctx.config.get<unknown>('kg_recall_plan_limit'),
    3,
  );
  const processRecallEnabledRaw =
    ctx.config.get<unknown>('kg_recall_process_enabled') ??
    process.env['KG_RECALL_PROCESS_ENABLED'];
  const processRecallDisabled =
    typeof processRecallEnabledRaw === 'string'
      ? processRecallEnabledRaw.toLowerCase() === 'false'
      : processRecallEnabledRaw === false;
  const processLimit = parseNumberOrDefault(
    ctx.config.get<unknown>('kg_recall_process_limit'),
    3,
  );

  // Cost telemetry: wire the recorder to the shared graph pool and wrap the
  // client so the background Haiku scorers/extractors record their usage.
  const usagePool = ctx.services.get<Pool>('graphPool');
  if (usagePool) initUsageRecorder(usagePool);

  let llm: LlmProvider | undefined;
  if (apiKey) {
    llm = withProviderUsageTracking(
      createAnthropicProvider({ client: createAnthropicClient({ apiKey }) }),
      { source: 'extras' },
    );
  }

  // ---------------------------------------------------------------------
  // OB-71 — palaia capture-filter wiring.
  //
  // The filter ALWAYS runs (default level=minimal: deterministic privacy +
  // hint stripping, no LLM, no drop). At level=normal/aggressive the Haiku
  // significance-scorer kicks in — we build it only when an Anthropic key
  // is configured. The filter wraps `knowledgeGraph` via
  // `CaptureFilteringKnowledgeGraph` and replaces the registry entry, so
  // every consumer that activates AFTER us (orchestrator, channel-plugins,
  // …) sees the filtered KG transparently. The original KG stays live
  // behind the wrapper and is restored on plugin deactivate.
  // ---------------------------------------------------------------------
  const captureLevel = parseCaptureLevel(
    ctx.config.get<unknown>('capture_level'),
    DEFAULT_CAPTURE_LEVEL,
  );
  const captureDefaultVisibility = parseVisibility(
    ctx.config.get<unknown>('capture_default_visibility'),
    DEFAULT_CAPTURE_VISIBILITY,
  );
  const captureSignificanceThreshold = parseNumberOrDefault(
    ctx.config.get<unknown>('capture_significance_threshold'),
    defaultThresholdForLevel(captureLevel),
  );

  // Slice 8 — extract the scorer so the bulkPromotion service can
  // reuse it. CaptureFilter wraps it transparently for the live path;
  // the bulk job calls `.score(text)` directly.
  const significanceScorer = llm
    ? createHaikuSignificanceScorer({
        llm,
        model: factModel,
        log: ctx.log,
      })
    : undefined;

  const captureFilter = new CaptureFilter({
    captureLevel,
    defaultVisibility: captureDefaultVisibility,
    significanceThreshold: captureSignificanceThreshold,
    ...(significanceScorer ? { significanceScorer } : {}),
    log: ctx.log,
  });
  const disposeCaptureFilter = ctx.services.provide(
    CAPTURE_FILTER_SERVICE,
    captureFilter,
  );

  const captureWrappedKg = new CaptureFilteringKnowledgeGraph({
    inner: knowledgeGraph,
    filter: captureFilter,
    log: ctx.log,
  });

  // Slice 9 — Inconsistency detector + triggering wrapper. Stack
  // order: capture-filter (inner) → inconsistency-trigger.
  // The trigger fires fire-and-forget AFTER each MK mutation; the
  // detector calls back into the same wrapped KG via the published
  // service so its own searches see the same view live readers do.
  const inconsistencyDetector = createInconsistencyDetector({
    graph: captureWrappedKg,
    ...(embeddingClient ? { embeddingClient } : {}),
    ...(llm ? { llm, model: factModel } : {}),
    log: (msg) => { console.error(msg); },
  });
  const disposeInconsistencyDetector = ctx.services.provide(
    INCONSISTENCY_DETECTOR_SERVICE_NAME,
    inconsistencyDetector,
  );
  const inconsistencyWrappedKg = new InconsistencyTriggeringKnowledgeGraph({
    inner: captureWrappedKg,
    detector: inconsistencyDetector,
    log: (msg) => { console.error(msg); },
  });
  ctx.log(
    `[harness-orchestrator-extras] inconsistency-detector ready (embed=${embeddingClient ? 'on' : 'off'}, judge=${llm ? 'on' : 'off'})`,
  );

  // Slice 10 — MergeCandidate detector + triggering wrapper. Stack
  // order: capture-filter → inconsistency-trigger → merge-trigger
  // (outermost). Cosine-only, no Anthropic dependency. Always active
  // when embeddingClient is wired.
  const mergeCandidateDetector = createMergeCandidateDetector({
    graph: inconsistencyWrappedKg,
    ...(embeddingClient ? { embeddingClient } : {}),
    log: (msg) => { console.error(msg); },
  });
  const disposeMergeCandidateDetector = ctx.services.provide(
    MERGE_CANDIDATE_DETECTOR_SERVICE_NAME,
    mergeCandidateDetector,
  );
  const wrappedKg = new MergeTriggeringKnowledgeGraph({
    inner: inconsistencyWrappedKg,
    detector: mergeCandidateDetector,
    log: (msg) => { console.error(msg); },
  });
  const disposeWrappedKg = ctx.services.replace(
    KNOWLEDGE_GRAPH_SERVICE,
    wrappedKg,
  );
  ctx.log(
    `[harness-orchestrator-extras] merge-candidate-detector ready (embed=${embeddingClient ? 'on' : 'off'})`,
  );

  ctx.log(
    `[harness-orchestrator-extras] capture-filter activated (level=${captureLevel}, threshold=${captureSignificanceThreshold.toFixed(2)}, visibility=${captureDefaultVisibility}, scorer=${captureLevel === 'minimal' || captureLevel === 'off' ? 'disabled-by-level' : llm ? 'haiku' : 'unavailable-no-key'})`,
  );

  // OB-76 — Process-Memory handle, resolved once and reused below (the
  // nudge side-channel at the bottom of this activate() reuses the same
  // const). Optional capability: absent when the KG provider has no
  // `processes` table (in-memory / no database_url) → the process-recall
  // leg is skipped, plan + memory legs still run.
  const processMemory = ctx.services.get<ProcessMemoryService>(
    PROCESS_MEMORY_SERVICE_NAME,
  );

  // Downstream consumers inside this package use the wrapped KG too — keeps
  // ContextRetriever's reads consistent with the swapped registry entry.
  const contextRetriever = new ContextRetriever(
    wrappedKg,
    {
      recallMinScore,
      recallRecencyBoost,
      recallTypeWeights,
      defaultBudgetTokens: contextDefaultBudgetTokens,
      charsPerToken: contextCharsPerToken,
      manualBoostFactor: contextManualBoostFactor,
      compactModeThreshold: contextCompactModeThreshold,
      memoryRecallDisabled,
      memoryLimit,
      excerptsPerMemory: memoryExcerptsPerMemory,
      memoryMinSimilarity,
      memoryBoostFactor,
      // Cross-session recall probe.
      teamVisibility,
      planRecallDisabled,
      planLimit,
      processRecallDisabled,
      processLimit,
    },
    embeddingClient,
    agentPriorities,
    processMemory,
  );
  ctx.log(
    `[harness-orchestrator-extras] context-assembler ready (budget=${String(contextDefaultBudgetTokens)}tk, chars/tk=${String(contextCharsPerToken)}, manual-boost=${contextManualBoostFactor.toFixed(2)}, compact>${String(contextCompactModeThreshold)}, agentPriorities=${agentPriorities ? 'on' : 'off'}, memoryRecall=${embeddingClient && !memoryRecallDisabled ? `on(limit=${String(memoryLimit)},excerpts=${String(memoryExcerptsPerMemory)},minSim=${memoryMinSimilarity.toFixed(2)})` : 'off'}, teamVisibility=${teamVisibility ? 'on' : 'off'}, planRecall=${planRecallDisabled ? 'off' : `on(limit=${String(planLimit)})`}, processRecall=${processMemory && !processRecallDisabled ? `on(limit=${String(processLimit)})` : 'off'})`,
  );
  const disposeContext = ctx.services.provide(
    CONTEXT_RETRIEVER_SERVICE,
    contextRetriever,
  );

  // Slice 8 — bulk score+promote service, always published. `preview`
  // works without a scorer (returns scorerAvailable=false); `run`
  // throws bulk.scorer_unavailable when called without one. Pool is
  // resolved from the optional graphPool capability — when absent,
  // the service stays unpublished.
  let disposeBulkPromotion: (() => void) | undefined;
  const bulkPromotionPool = ctx.services.get<Pool>('graphPool');
  const bulkPromotionTenantId =
    ctx.config.get<string>('graph_tenant_id') ??
    process.env['GRAPH_TENANT_ID'] ??
    'default';
  if (bulkPromotionPool) {
    const bulkPromotion = createBulkPromotionService({
      pool: bulkPromotionPool,
      tenantId: bulkPromotionTenantId,
      kg: wrappedKg,
      ...(significanceScorer ? { scorer: significanceScorer } : {}),
      log: (msg) => { console.error(msg); },
    });
    disposeBulkPromotion = ctx.services.provide(
      BULK_PROMOTION_SERVICE_NAME,
      bulkPromotion,
    );
    ctx.log(
      `[harness-orchestrator-extras] bulkPromotion ready (scorer=${significanceScorer ? 'on' : 'off'}, tenant=${bulkPromotionTenantId})`,
    );
  } else {
    ctx.log(
      '[harness-orchestrator-extras] bulkPromotion skipped — graphPool capability not published',
    );
  }

  // WS5 — Scratchpad-Promotion Reaper. Periodically consolidates
  // significant, aged agent-scratch memory (PostgresMemoryStore
  // `memory_files` under `/memories/orchestrators/<slug>/…`) into the KG
  // as owner-less, agent-scoped MemorableKnowledge. Starts ONLY when:
  // enabled AND graphPool present AND a SignificanceScorer is available
  // (needs an Anthropic key) — mirrors turn-promotion's no-DB / no-key
  // no-op. The first scan is NOT run synchronously at activate (don't
  // block boot); a short-delayed kick fires the first pass, then the
  // interval takes over.
  let stopScratchReaper: (() => void) | undefined;
  const scratchPromotionEnabled = parseBoolDefaultTrue(
    ctx.config.get<unknown>('scratch_promotion_enabled'),
  );
  const scratchPromotionIntervalMinutes = parseNumberOrDefault(
    ctx.config.get<unknown>('scratch_promotion_interval_minutes'),
    60,
  );
  const scratchPromotionAgeHours = parseNumberOrDefault(
    ctx.config.get<unknown>('scratch_promotion_age_hours'),
    24,
  );
  const scratchPromotionThreshold = parseNumberOrDefault(
    ctx.config.get<unknown>('scratch_promotion_threshold'),
    captureSignificanceThreshold,
  );
  // Opt-in destructive TTL of non-promoted aged scratch. Default false —
  // the reaper never destroys scratch it didn't promote unless told to.
  const scratchPromotionDropUnpromoted = parseBoolDefaultFalse(
    ctx.config.get<unknown>('scratch_promotion_drop_unpromoted'),
  );
  {
    let disabledReason: string | undefined;
    if (!scratchPromotionEnabled) {
      disabledReason = 'config scratch_promotion_enabled=false';
    } else if (!bulkPromotionPool) {
      disabledReason = 'graphPool capability not published';
    } else if (!significanceScorer) {
      disabledReason = 'no significance scorer (Anthropic key missing)';
    }

    if (disabledReason) {
      ctx.log(
        `[harness-orchestrator-extras] scratch-promotion reaper disabled: ${disabledReason}`,
      );
    } else if (bulkPromotionPool && significanceScorer) {
      // Re-narrowed for the type-checker (the guards above already
      // guarantee both are present when disabledReason is undefined).
      const reaperPool = bulkPromotionPool;
      const reaperScorer = significanceScorer;
      const intervalMs = Math.max(1, scratchPromotionIntervalMinutes) * 60_000;
      const ageMs = Math.max(0, scratchPromotionAgeHours) * 3_600_000;
      const reaper = createScratchPromotionReaper({
        pool: reaperPool,
        tenantId: bulkPromotionTenantId,
        kg: wrappedKg,
        scorer: reaperScorer,
        threshold: scratchPromotionThreshold,
        ageMs,
        intervalMs,
        defaultVisibility: captureDefaultVisibility,
        dropUnpromoted: scratchPromotionDropUnpromoted,
        log: (msg) => { console.error(msg); },
      });
      reaper.start();
      stopScratchReaper = () => { reaper.stop(); };
      // Kick a first pass off the boot critical-path (don't await in
      // activate). Errors are swallowed inside runOnce.
      const kick = setTimeout(() => { void reaper.runOnce(); }, 30_000);
      if (typeof kick.unref === 'function') kick.unref();
      ctx.log(
        `[harness-orchestrator-extras] scratch-promotion reaper on every ${String(scratchPromotionIntervalMinutes)}min, age=${String(scratchPromotionAgeHours)}h, threshold=${scratchPromotionThreshold.toFixed(2)}, dropUnpromoted=${String(scratchPromotionDropUnpromoted)}`,
      );
    }
  }

  // Slice 9.5 — operator-triggered bulk inconsistency-detect pass.
  // Reuses the Slice-9 detector (already constructed above) and the
  // wrapped KG. Always publishes — `preview()` reflects whether the
  // judgement-pass is wired (Anthropic key present); `run()` throws
  // `bulk.detector_unavailable` if the operator triggers it without
  // a key configured.
  const bulkInconsistency = createBulkInconsistencyService({
    kg: wrappedKg,
    detector: inconsistencyDetector,
    judgementAvailable: llm !== undefined,
    log: (msg) => { console.error(msg); },
  });
  const disposeBulkInconsistency = ctx.services.provide(
    BULK_INCONSISTENCY_SERVICE_NAME,
    bulkInconsistency,
  );
  ctx.log(
    `[harness-orchestrator-extras] bulkInconsistency ready (judge=${llm ? 'on' : 'off'})`,
  );

  // Slice 10 — bulk merge-detect service. Cosine-only → always
  // available (no Anthropic key gate). `preview()` reports
  // `detectorAvailable: true` unconditionally.
  const bulkMergeDetect = createBulkMergeDetectService({
    kg: wrappedKg,
    detector: mergeCandidateDetector,
    log: (msg) => { console.error(msg); },
  });
  const disposeBulkMergeDetect = ctx.services.provide(
    BULK_MERGE_DETECT_SERVICE_NAME,
    bulkMergeDetect,
  );
  ctx.log(
    `[harness-orchestrator-extras] bulkMergeDetect ready (embed=${embeddingClient ? 'on' : 'off'})`,
  );

  // Slice 12 — Bulk Excerpt Merge Detect. Cosine-only (no Anthropic
  // dep) — always available when embeddingClient is wired.
  const bulkExcerptMergeDetect = createBulkExcerptMergeDetectService({
    kg: wrappedKg,
    detector: mergeCandidateDetector,
    log: (msg) => { console.error(msg); },
  });
  const disposeBulkExcerptMergeDetect = ctx.services.provide(
    BULK_EXCERPT_MERGE_DETECT_SERVICE_NAME,
    bulkExcerptMergeDetect,
  );
  ctx.log(
    `[harness-orchestrator-extras] bulkExcerptMergeDetect ready (embed=${embeddingClient ? 'on' : 'off'})`,
  );

  // Slice 11 — Topic clustering. Operator-triggered, cosine-only
  // discovery + optional Haiku naming (falls back to "Cluster N" when
  // no Anthropic key). Always published; the route 503s nothing — even
  // without Haiku the operator can still cluster + browse.
  const topicClustering = createTopicClusteringService({
    kg: wrappedKg,
    ...(llm ? { llm, model: factModel } : {}),
    log: (msg) => { console.error(msg); },
  });
  const disposeTopicClustering = ctx.services.provide(
    TOPIC_CLUSTERING_SERVICE_NAME,
    topicClustering,
  );
  ctx.log(
    `[harness-orchestrator-extras] topicClustering ready (naming=${llm ? 'haiku' : 'fallback'})`,
  );

  let disposeFactExtractor: (() => void) | undefined;
  let disposeTopicDetector: (() => void) | undefined;
  let disposeSessionBriefing: (() => void) | undefined;
  let disposePalaiaExcerpt: (() => void) | undefined;

  if (llm) {
    const factExtractor = new FactExtractor({
      llm,
      graph: wrappedKg,
      model: factModel,
    });
    disposeFactExtractor = ctx.services.provide(
      FACT_EXTRACTOR_SERVICE,
      factExtractor,
    );

    // KG-ACL Slice 4a — Palaia-Excerpt-Extractor. Same Haiku key as the
    // fact-extractor + session-summary generator; no separate config
    // surface to make this opt-in. The orchestrator plugin's activate()
    // picks it up via `palaiaExcerpt` service-name and threads it
    // through new Orchestrator({…, excerptExtractor}).
    const palaiaExcerptExtractor = createHaikuPalaiaExcerptExtractor({
      llm,
      model: factModel,
      log: (msg) => { console.error(msg); },
    });
    disposePalaiaExcerpt = ctx.services.provide(
      PALAIA_EXCERPT_SERVICE_NAME,
      palaiaExcerptExtractor,
    );

    // OB-75 (Phase 6) — Session-Continuity. Only published when an
    // Anthropic key is configured (the LLM-call is only path of the
    // briefing flow that actually needs it). Optional graphPool is
    // resolved if KG-Neon published it — without pool the briefing
    // skips the open-tasks block (graceful degrade).
    const summaryGenerator = createHaikuSessionSummaryGenerator({
      llm,
      model: factModel,
      log: (msg) => { console.error(msg); },
    });
    const graphPool = ctx.services.get<Pool>('graphPool');
    const briefingTenantId =
      ctx.config.get<string>('graph_tenant_id') ??
      process.env['GRAPH_TENANT_ID'] ??
      'default';
    const briefingService = createSessionBriefingService({
      kg: wrappedKg,
      summaryGenerator,
      ...(graphPool ? { pool: graphPool, tenantId: briefingTenantId } : {}),
      log: (msg) => { console.error(msg); },
    });
    disposeSessionBriefing = ctx.services.provide(
      SESSION_BRIEFING_SERVICE,
      briefingService,
    );
    ctx.log(
      `[harness-orchestrator-extras] sessionBriefing ready (openTasksLookup=${graphPool ? 'on' : 'off'})`,
    );

    if (embeddingClient) {
      const topicDetector = new TopicDetector(embeddingClient, llm, {
        upperThreshold,
        lowerThreshold,
        classifierModel,
      });
      disposeTopicDetector = ctx.services.provide(
        TOPIC_DETECTOR_SERVICE,
        topicDetector,
      );
    } else {
      ctx.log(
        '[harness-orchestrator-extras] embeddingClient missing — TopicDetector skipped (Teams topic routing falls back to continue-default)',
      );
    }
  } else {
    ctx.log(
      '[harness-orchestrator-extras] no anthropic_api_key configured — FactExtractor + TopicDetector skipped (ContextRetriever still active)',
    );
  }

  // OB-77 (Palaia Phase 8) — publish the lead heuristic into the
  // `nudgeProviders@1` side-channel. The orchestrator pulls this list
  // at its own activate-time and merges entries into its NudgeRegistry.
  // Side-channel design solves the activation-order problem: this plugin
  // activates BEFORE `harness-orchestrator` (orchestrator depends on
  // `contextRetriever@1` published here), so a direct registry.register
  // would race against an empty registry. (`processMemory` was resolved
  // once above for the context-retriever and is reused here.)
  const processPromoteProvider = new ProcessPromoteProvider({
    ...(processMemory ? { processMemory } : {}),
    log: (msg) => { console.error(msg); },
  });
  const nudgeProviders: readonly NudgeProvider[] = [processPromoteProvider];
  const disposeNudgeProviders = ctx.services.provide(
    NUDGE_PROVIDERS_SERVICE_NAME,
    nudgeProviders,
  );
  ctx.log(
    `[harness-orchestrator-extras] palaia.process-promote queued via nudgeProviders@1 (processMemory=${processMemory ? 'on' : 'off'})`,
  );

  ctx.log(
    `[harness-orchestrator-extras] ready (contextRetriever=on, factExtractor=${llm ? 'on' : 'off'}, topicDetector=${llm && embeddingClient ? 'on' : 'off'}, sessionBriefing=${disposeSessionBriefing ? 'on' : 'off'}, palaiaExcerpt=${disposePalaiaExcerpt ? 'on' : 'off'}, nudgeProviders=on)`,
  );

  return {
    async close(): Promise<void> {
      ctx.log('[harness-orchestrator-extras] deactivating');
      // OB-77 — drop the nudgeProviders@1 publication. The orchestrator's
      // copy is in its NudgeRegistry already (consumed at activate-time);
      // the InMemoryNudgeRegistry has no unregister surface today, so
      // hot-uninstall of an already-registered provider is best-effort
      // until OB-78's curate-cron introduces a proper retire API.
      disposeNudgeProviders();
      disposePalaiaExcerpt?.();
      disposeSessionBriefing?.();
      disposeTopicDetector?.();
      disposeFactExtractor?.();
      disposeTopicClustering();
      disposeBulkExcerptMergeDetect();
      disposeBulkMergeDetect();
      disposeBulkInconsistency();
      disposeBulkPromotion?.();
      stopScratchReaper?.();
      disposeContext();
      // Tear down KG wrappers FIRST (restores original provider), THEN
      // the captureFilter capability — symmetric with the activate order.
      // Stack disposal: outermost (merge-trigger) → inconsistency-trigger
      // is implicit (the `services.replace` only swaps the outermost; the
      // inner wrappers go out of scope with their parent).
      disposeWrappedKg();
      disposeMergeCandidateDetector();
      disposeInconsistencyDetector();
      disposeCaptureFilter();
    },
  };
}

function parseNumberOrDefault(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

/** Parse a tri-state config boolean that defaults to TRUE when unset.
 *  Only an explicit `false` / `'false'` (case-insensitive) disables. */
function parseBoolDefaultTrue(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.trim().toLowerCase() !== 'false';
  return true;
}

function parseBoolDefaultFalse(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.trim().toLowerCase() === 'true';
  return false;
}

function parseCaptureLevel(
  value: unknown,
  fallback: CaptureLevel,
): CaptureLevel {
  if (typeof value !== 'string') return fallback;
  const v = value.trim().toLowerCase();
  if (v === 'off' || v === 'minimal' || v === 'normal' || v === 'aggressive') {
    return v;
  }
  return fallback;
}

function parseVisibility(value: unknown, fallback: Visibility): Visibility {
  if (typeof value !== 'string') return fallback;
  const v = value.trim();
  if (v === 'private' || v === 'team' || v === 'public') return v;
  if (v.startsWith('shared:') && v.length > 'shared:'.length) {
    return v as Visibility;
  }
  return fallback;
}
