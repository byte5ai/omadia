import Anthropic from '@anthropic-ai/sdk';
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
  BULK_PROMOTION_SERVICE_NAME,
  INCONSISTENCY_DETECTOR_SERVICE_NAME,
  NUDGE_PROVIDERS_SERVICE_NAME,
  PALAIA_EXCERPT_SERVICE_NAME,
  PROCESS_MEMORY_SERVICE_NAME,
} from '@omadia/plugin-api';

import {
  CaptureFilter,
  type CaptureLevel,
  defaultThresholdForLevel,
} from './captureFilter.js';
import { CaptureFilteringKnowledgeGraph } from './captureFilteringKnowledgeGraph.js';
import { ContextRetriever } from './contextRetriever.js';
import type { Pool } from 'pg';

import { createBulkPromotionService } from './bulkPromotion.js';
import { createHaikuPalaiaExcerptExtractor } from './excerptExtractor.js';
import { createInconsistencyDetector } from './inconsistencyDetector.js';
import { InconsistencyTriggeringKnowledgeGraph } from './inconsistencyTriggeringKnowledgeGraph.js';
import { FactExtractor } from './factExtractor.js';
import { createHaikuSessionSummaryGenerator } from './sessionSummaryGenerator.js';
import { createSessionBriefingService } from './sessionBriefing.js';
import { createHaikuSignificanceScorer } from './significanceScorer.js';
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
const DEFAULT_CAPTURE_LEVEL: CaptureLevel = 'minimal';
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

  // S+12.6: anthropic_api_key is vault-stored (matches database_url-pattern).
  // Bootstrap migrates pre-S+12.6 entries automatically (config → vault).
  const apiKey = ((await ctx.secrets.get('anthropic_api_key')) ?? '').trim();
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

  let anthropic: Anthropic | undefined;
  if (apiKey) {
    anthropic = new Anthropic({ apiKey });
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
  const significanceScorer = anthropic
    ? createHaikuSignificanceScorer({
        anthropic,
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
  // order: capture-filter (inner) → inconsistency-trigger (outer).
  // The trigger fires fire-and-forget AFTER each MK mutation; the
  // detector calls back into the same wrapped KG via the published
  // service so its own searches see the same view live readers do.
  const inconsistencyDetector = createInconsistencyDetector({
    graph: captureWrappedKg,
    ...(embeddingClient ? { embeddingClient } : {}),
    ...(anthropic ? { anthropic, model: factModel } : {}),
    log: (msg) => { console.error(msg); },
  });
  const disposeInconsistencyDetector = ctx.services.provide(
    INCONSISTENCY_DETECTOR_SERVICE_NAME,
    inconsistencyDetector,
  );
  const wrappedKg = new InconsistencyTriggeringKnowledgeGraph({
    inner: captureWrappedKg,
    detector: inconsistencyDetector,
    log: (msg) => { console.error(msg); },
  });
  const disposeWrappedKg = ctx.services.replace(
    KNOWLEDGE_GRAPH_SERVICE,
    wrappedKg,
  );
  ctx.log(
    `[harness-orchestrator-extras] inconsistency-detector ready (embed=${embeddingClient ? 'on' : 'off'}, judge=${anthropic ? 'on' : 'off'})`,
  );

  ctx.log(
    `[harness-orchestrator-extras] capture-filter activated (level=${captureLevel}, threshold=${captureSignificanceThreshold.toFixed(2)}, visibility=${captureDefaultVisibility}, scorer=${captureLevel === 'minimal' || captureLevel === 'off' ? 'disabled-by-level' : anthropic ? 'haiku' : 'unavailable-no-key'})`,
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
    },
    embeddingClient,
    agentPriorities,
  );
  ctx.log(
    `[harness-orchestrator-extras] context-assembler ready (budget=${String(contextDefaultBudgetTokens)}tk, chars/tk=${String(contextCharsPerToken)}, manual-boost=${contextManualBoostFactor.toFixed(2)}, compact>${String(contextCompactModeThreshold)}, agentPriorities=${agentPriorities ? 'on' : 'off'}, memoryRecall=${embeddingClient && !memoryRecallDisabled ? `on(limit=${String(memoryLimit)},excerpts=${String(memoryExcerptsPerMemory)},minSim=${memoryMinSimilarity.toFixed(2)})` : 'off'})`,
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

  let disposeFactExtractor: (() => void) | undefined;
  let disposeTopicDetector: (() => void) | undefined;
  let disposeSessionBriefing: (() => void) | undefined;
  let disposePalaiaExcerpt: (() => void) | undefined;

  if (anthropic) {
    const factExtractor = new FactExtractor({
      anthropic,
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
      anthropic,
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
      anthropic,
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
      const topicDetector = new TopicDetector(embeddingClient, anthropic, {
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
  // would race against an empty registry.
  const processMemory = ctx.services.get<ProcessMemoryService>(
    PROCESS_MEMORY_SERVICE_NAME,
  );
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
    `[harness-orchestrator-extras] ready (contextRetriever=on, factExtractor=${anthropic ? 'on' : 'off'}, topicDetector=${anthropic && embeddingClient ? 'on' : 'off'}, sessionBriefing=${disposeSessionBriefing ? 'on' : 'off'}, palaiaExcerpt=${disposePalaiaExcerpt ? 'on' : 'off'}, nudgeProviders=on)`,
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
      disposeBulkPromotion?.();
      disposeContext();
      // Tear down KG wrappers FIRST (restores original provider), THEN
      // the captureFilter capability — symmetric with the activate order.
      // The triggering wrapper is the outer; CFKG is the inner.
      disposeWrappedKg();
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
