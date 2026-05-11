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
