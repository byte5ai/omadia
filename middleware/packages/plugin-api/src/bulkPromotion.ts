/**
 * @omadia/plugin-api — Bulk-Promotion capability contract (Slice 8).
 *
 * Operator-triggered retrospective pass over historical Turns:
 *   1. SCORE — every Turn with `significance IS NULL` is fed through
 *      the configured SignificanceScorer (Haiku) and the column is
 *      written.
 *   2. PROMOTE — every Turn with `significance >= threshold` that
 *      isn't already promoted (no DERIVED_FROM edge to a MK) is
 *      passed to `promoteTurnIfSignificant`.
 *
 * Both phases are idempotent. A re-run only does work for new
 * candidates. The capability is published by `harness-orchestrator-
 * extras` and consumed by the admin route — no plugin outside the
 * core uses it today.
 */

export interface BulkPromotePreview {
  /** Turns that would be SCORED on a run (significance IS NULL). */
  nullSignificanceCount: number;
  /** Turns at or above threshold that aren't promoted yet. */
  eligibleForPromoteCount: number;
  /** Already-promoted Turns at or above threshold (context only). */
  alreadyPromotedCount: number;
  /** False when no SignificanceScorer is wired — SCORE phase will 503. */
  scorerAvailable: boolean;
  /** Threshold used to compute the eligibility numbers. */
  threshold: number;
}

export interface BulkPromoteRunOptions {
  /** Max Turns scored per run. Hard-capped at 1000. Default 100. */
  scoreLimit?: number;
  /** Max Turns promoted per run. Hard-capped at 1000. Default 100. */
  promoteLimit?: number;
  /** Significance threshold for promotion. Default 0.7. */
  threshold?: number;
}

export interface BulkScorePhaseResult {
  scanned: number;
  scored: number;
  failed: number;
}

export interface BulkPromotePhaseResult {
  scanned: number;
  promoted: number;
  alreadyPromoted: number;
  belowThreshold: number;
  failed: number;
}

export interface BulkPromoteRunResult {
  scorePhase: BulkScorePhaseResult;
  promotePhase: BulkPromotePhaseResult;
  durationMs: number;
}

/**
 * Service surface published by the bulk-promotion provider. Throws
 * `{ code: 'bulk.scorer_unavailable' }` from `run` when no
 * SignificanceScorer is configured (typical: missing Anthropic key).
 */
export interface BulkPromotionService {
  preview(threshold: number): Promise<BulkPromotePreview>;
  run(options?: BulkPromoteRunOptions): Promise<BulkPromoteRunResult>;
}

export const BULK_PROMOTION_SERVICE_NAME = 'bulkPromotion';
export const BULK_PROMOTION_CAPABILITY = 'bulkPromotion@1';
