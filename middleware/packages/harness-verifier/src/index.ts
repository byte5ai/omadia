/**
 * @omadia/verifier — public barrel.
 *
 * Sub-Commit 2b: capability lifetime flipped. `activate()` constructs
 * the five-stage verifier pipeline (ClaimExtractor + DeterministicChecker
 * + GraphEvidenceFetcher + EvidenceJudge + VerifierPipeline) plus an
 * optional VerifierStore (only when `graphPool` is resolvable from the
 * registry — the in-memory KG variant has no Postgres pool), and
 * publishes the bundle as `verifier@1`. See `plugin.ts` for the bundle
 * shape (`VerifierBundle`).
 *
 * **The kernel-side `VerifierService` wrapper is intentionally NOT
 * moved here.** It consumes seven kernel-internal symbols from
 * `src/services/orchestrator.ts` (Orchestrator, ChatAgent,
 * ChatStreamEvent, ChatTurnInput, ChatTurnResult, VerifierResultSummary,
 * toSemanticAnswer) plus `RunTracePayload` from
 * `src/services/runTraceCollector.ts`. Lifting the orchestrator surface
 * to `@omadia/plugin-api` is a separate refactor (S+10+ scope —
 * the Orchestrator class is ~1k LOC and not yet plugin-extractable).
 * VerifierService stays kernel-side as the orchestrator-binding wrapper;
 * the kernel late-resolves `verifier@1` after Orchestrator construction
 * and wraps the bundle's pipeline + (optional) store with VerifierService.
 *
 * The `createGraphLookupTool` factory is exported for kernel-side
 * accounting/HR LocalSubAgent construction (it produces a
 * `LocalSubAgentTool` from `@omadia/plugin-api` — no service-
 * capability, just a factory function). The kernel imports it directly
 * from this package's barrel.
 */

export { activate } from './plugin.js';
export type { VerifierBundle, VerifierPluginHandle } from './plugin.js';

// ClaimExtractor
export { ClaimExtractor } from './claimExtractor.js';
export type {
  ClaimExtractorOptions,
  ExtractInput,
} from './claimExtractor.js';

// claimTypes — shared vocabulary used by every other verifier file plus
// the kernel-side `verifierService.ts` until sub-commit 2b moves it.
export {
  isHardClaim,
  isSoftClaim,
} from './claimTypes.js';
export type {
  Aggregation,
  Claim,
  ClaimSource,
  ClaimType,
  ClaimVerdict,
  HardClaim,
  OdooRecordRef,
  SoftClaim,
  VerifierBadge,
  VerifierInput,
  VerifierVerdict,
} from './claimTypes.js';

// correctionPrompt
export { buildCorrectionPrompt } from './correctionPrompt.js';

// DeterministicChecker
export { DeterministicChecker } from './deterministicChecker.js';
export type {
  DeterministicCheckerOptions,
  GraphReader,
  OdooReader,
} from './deterministicChecker.js';

// EvidenceJudge
export { EvidenceJudge } from './evidenceJudge.js';
export type {
  EvidenceFetcher,
  EvidenceJudgeOptions,
  EvidenceSnippet,
} from './evidenceJudge.js';

// failureReplayDetector
export { detectFailureReplay } from './failureReplayDetector.js';

// GraphEvidenceFetcher
export { GraphEvidenceFetcher } from './graphEvidenceFetcher.js';
export type { GraphEvidenceFetcherOptions } from './graphEvidenceFetcher.js';

// graphLookupTool — sub-agent tool factory consumed by the accounting/HR
// LocalSubAgent constructions in the kernel. Returns a
// `LocalSubAgentTool` (shape lifted to `@omadia/plugin-api` in
// sub-commit 2a).
export { createGraphLookupTool } from './graphLookupTool.js';

// triggerRouter
export { shouldTriggerVerifier } from './triggerRouter.js';
export type { TriggerDecision } from './triggerRouter.js';

// VerifierPipeline
export { VerifierPipeline } from './verifierPipeline.js';
export type { VerifierPipelineOptions } from './verifierPipeline.js';

// VerifierStore
export { VerifierStore } from './verifierStore.js';
export type {
  PersistVerdictInput,
  VerifierStoreOptions,
} from './verifierStore.js';
