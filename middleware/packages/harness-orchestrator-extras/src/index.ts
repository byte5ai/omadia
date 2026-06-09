/**
 * @omadia/orchestrator-extras — public barrel.
 *
 * Sub-Commit 2a: re-exports the four moved tool-set classes plus the
 * `sessionTranscriptParser` helper that `graphBackfill` consumes (no
 * other kernel-side caller — moves cleanly with the plugin). Plugin
 * activate() is still no-op; kernel `src/index.ts` continues to
 * construct each class directly. Sub-Commit 2b will (a) declare the
 * four `requires:` (knowledgeGraph, entityRefBus, embeddingClient,
 * memoryStore), (b) build the classes inside this package's
 * `activate()` against `ctx.services.get`, and (c) delete the kernel-
 * side construction.
 */

export { activate } from './plugin.js';
export type { OrchestratorExtrasPluginHandle } from './plugin.js';

export { ContextRetriever, extractCandidateTerms } from './contextRetriever.js';
// KG-walk chat visualization — builds the per-turn `kg_graph` payload of the
// recalled Knowledge-Graph neighbourhood. Best-effort, UI-only.
export { buildKgInsertPayload, buildKgWalkPayload } from './kgWalkPayload.js';
export type {
  ContextRetrieverOptions,
  ContextBuildInput,
  ContextBuildResult,
  AssembleForBudgetInput,
  AssembledContext,
  AssembledHit,
  AssembledHitReason,
  AssembledExclusion,
} from './contextRetriever.js';
// Cross-session recall payload types are canonically defined in
// @omadia/plugin-api; re-exported here for back-compat with consumers that
// import them alongside `AssembledContext` from this package.
export type {
  RecalledContext,
  RecalledPlan,
  RecalledProcess,
  RecalledInsight,
} from '@omadia/plugin-api';

// OB-75 — palaia Phase 6 Session-Continuity (Briefings + Summaries).
export {
  createHaikuSessionSummaryGenerator,
  SESSION_SUMMARY_MARKER,
} from './sessionSummaryGenerator.js';
export type {
  SessionSummaryGenerator,
  SessionSummaryInput,
  HaikuSessionSummaryGeneratorOptions,
} from './sessionSummaryGenerator.js';
export { createSessionBriefingService } from './sessionBriefing.js';
export type { SessionBriefingServiceOptions } from './sessionBriefing.js';

export { FactExtractor } from './factExtractor.js';
export type {
  FactExtractorOptions,
  ExtractInput,
  ExtractedFact,
} from './factExtractor.js';

export { TopicDetector } from './topicDetector.js';
export type {
  TopicDecision,
  TopicClassifyInput,
  TopicClassifyResult,
  TopicDetectorOptions,
} from './topicDetector.js';

export { backfillGraph } from './graphBackfill.js';
export type { BackfillResult } from './graphBackfill.js';

export { parseSessionTranscript } from './sessionTranscriptParser.js';
export type { ParsedTurn } from './sessionTranscriptParser.js';

// OB-71 — palaia capture-pipeline.
export {
  CaptureFilter,
  defaultThresholdForLevel,
  parseHints,
  stripPrivacy,
} from './captureFilter.js';
export type {
  CaptureFilterDecision,
  CaptureFilterDeps,
  CaptureLevel,
  SignificanceScorer,
} from './captureFilter.js';
export { createHaikuSignificanceScorer } from './significanceScorer.js';
export type { HaikuSignificanceScorerOptions } from './significanceScorer.js';
export { CaptureFilteringKnowledgeGraph } from './captureFilteringKnowledgeGraph.js';
export type { CaptureFilteringKnowledgeGraphOptions } from './captureFilteringKnowledgeGraph.js';

// KG-ACL Slice 4a — Palaia-Excerpt-Extractor for the save-as-memory
// suggestion. Capability contract lives in @omadia/plugin-api
// (PalaiaExcerpt + PalaiaExcerptExtractor); this Haiku-backed
// implementation is what the orchestrator wires into its `done`
// stream-event spread and what Slice 4b's auto-promotion pipeline
// hands to createMemorableKnowledge.
export { createHaikuPalaiaExcerptExtractor } from './excerptExtractor.js';
export type { HaikuPalaiaExcerptExtractorOptions } from './excerptExtractor.js';

// KG-ACL Slice 4b — Auto-Promotion at significance >= threshold.
// One fire-and-forget call per persisted turn from the orchestrator's
// chatStreamInner. Idempotent (DERIVED_FROM edge lookup) so a re-run
// stays a no-op. Requires `capture_level >= normal` so the scorer
// actually writes a significance value; below that the function
// declines all promotions with reason='no-significance'.
export { promoteTurnIfSignificant } from './promotion.js';
export type { PromoteTurnInput, PromoteTurnResult } from './promotion.js';

// KG-ACL Slice 8 — operator-triggered retrospective bulk score +
// promotion. Two-phase pass over historical Turns: (1) Haiku-score
// rows with significance=NULL, (2) promote rows with
// significance>=threshold via the same `promoteTurnIfSignificant`
// pipeline the live path uses. Idempotent in both phases.
export { createBulkPromotionService } from './bulkPromotion.js';
export type { BulkPromotionDeps } from './bulkPromotion.js';

// WS5 — Scratchpad-Promotion Reaper. Periodic background job that
// consolidates significant, aged agent-scratch memory (the
// PostgresMemoryStore `memory_files` tree under
// `/memories/orchestrators/<slug>/…`) into the KG as owner-less,
// agent-scoped MemorableKnowledge. Delete-after-create → idempotent.
export {
  createScratchPromotionReaper,
  deriveAgentSlug,
} from './scratchPromotionReaper.js';
export type {
  ScratchPromotionReaper,
  ScratchPromotionReaperDeps,
  ScratchReapRunResult,
} from './scratchPromotionReaper.js';

// KG-ACL Slice 9 — contradiction detector. Per MK create / update /
// auto-promotion: cosine top-k → Haiku judgement-pass → persist
// Inconsistency on disagreement. Idempotent on the (sorted) MK pair.
export { createInconsistencyDetector } from './inconsistencyDetector.js';
export type { InconsistencyDetectorDeps } from './inconsistencyDetector.js';

// KG-ACL Slice 9.5 — operator-triggered bulk pass over MKs without a
// `last_inconsistency_check_at` marker. Reuses the Slice-9 detector
// for the judgement pass; idempotent via the marker.
export { createBulkInconsistencyService } from './bulkInconsistency.js';
export type { BulkInconsistencyDeps } from './bulkInconsistency.js';

// KG-ACL Slice 10 — cosine-only near-duplicate detector (cosine ≥ 0.95),
// MergeTriggering wrapper, and bulk pass with separate marker.
export { createMergeCandidateDetector } from './mergeCandidateDetector.js';
export type { MergeCandidateDetectorDeps } from './mergeCandidateDetector.js';
export { MergeTriggeringKnowledgeGraph } from './mergeTriggeringKnowledgeGraph.js';
export type { MergeTriggeringKnowledgeGraphOptions } from './mergeTriggeringKnowledgeGraph.js';
export { createBulkMergeDetectService } from './bulkMergeDetect.js';
export type { BulkMergeDetectDeps } from './bulkMergeDetect.js';

// KG-ACL Slice 11 — operator-triggered Topic clustering. Connected-
// components on cosine ≥ threshold; Haiku-generated names with
// "Cluster N" fallback when no Anthropic key is configured.
export { createTopicClusteringService } from './topicClustering.js';
export type { TopicClusteringDeps } from './topicClustering.js';

// KG-ACL Slice 12 — bulk pass over PalaiaExcerpts without a
// `last_excerpt_merge_check_at` marker; complements the live trigger
// in MergeTriggeringKnowledgeGraph's `updateExcerpt` decoration.
export { createBulkExcerptMergeDetectService } from './bulkExcerptMergeDetect.js';
export type { BulkExcerptMergeDetectDeps } from './bulkExcerptMergeDetect.js';
