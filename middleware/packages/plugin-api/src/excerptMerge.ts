/**
 * @omadia/plugin-api — ExcerptMergeCandidate capability (KG-ACL Slice 12).
 *
 * Mirrors Slice 10 MergeCandidate, but at the PalaiaExcerpt layer:
 * two excerpts whose cosine similarity is ≥ 0.97 are near-duplicate
 * source-snippets (either under the same MK or across MKs). The
 * detector persists each such pair as an `ExcerptMergeCandidate` node
 * with two `DUPLICATE_EXCERPT_OF` edges (one per offending excerpt)
 * and surfaces them in `/admin/duplicates` (Excerpts tab) for
 * operator-resolve.
 *
 * Detection is cosine-only (no Haiku) — at ≥ 0.97 the content overlap
 * is high enough that one excerpt is a near-verbatim restatement of
 * the other. Operator picks `keep_a` / `keep_b` / `not_duplicate`;
 * keep_a/keep_b delete the loser excerpt via `deleteExcerpt`.
 */

export type ExcerptMergeStatus = 'open' | 'resolved' | 'dismissed';

export type ExcerptMergeResolution =
  /** Excerpt A is the keeper → excerpt B is deleted via deleteExcerpt. */
  | 'keep_a'
  /** Excerpt B is the keeper → excerpt A is deleted via deleteExcerpt. */
  | 'keep_b'
  /** Detector overshot — these aren't actually duplicates. */
  | 'not_duplicate';

export interface ExcerptMergeCandidateNode {
  /** External id, scheme `excerpt-merge:<uuid>`. */
  id: string;
  type: 'ExcerptMergeCandidate';
  props: {
    /** Cosine similarity captured at detect-time, in [0.97, 1.0]. */
    cosine_sim: number;
    status: ExcerptMergeStatus;
    resolution: ExcerptMergeResolution | null;
    created_at: string;
    resolved_at: string | null;
    /** Cluster-root that resolved the candidate; null while open. */
    resolved_by: string | null;
  };
  /** External ids of the two near-duplicate Excerpts, sorted
   *  ascending so dedupe-checks are direction-independent. */
  duplicateExcerptOf: [string, string];
}

export interface ListExcerptMergeCandidatesOptions {
  viewerOmadiaUserId: string;
  status?: ExcerptMergeStatus;
  /** Clamped to [1, 200]. Default 50. */
  limit?: number;
}

export interface CreateExcerptMergeCandidateInput {
  excerptAExternalId: string;
  excerptBExternalId: string;
  /** Cosine similarity at detect-time. Should be ≥ 0.97. */
  cosineSim: number;
}

// ─── Slice 12 · Bulk Excerpt Merge Detect (mirrors Slice 10.5) ─────

export interface BulkExcerptMergeDetectPreview {
  unchecked: number;
  alreadyChecked: number;
  withoutEmbedding: number;
  /** Always `true` for cosine-only detection. Shape parity with the
   *  Slice 9.5 / 10 bulk-preview payloads. */
  detectorAvailable: boolean;
}

export interface BulkExcerptMergeDetectRunOptions {
  /** Max Excerpts processed per call. Hard-capped at 500. Default 50. */
  limit?: number;
}

export interface BulkExcerptMergeDetectResult {
  scanned: number;
  checked: number;
  excerptMergeCandidatesCreated: number;
  skippedNoEmbedding: number;
  failed: number;
  durationMs: number;
}

export interface BulkExcerptMergeDetectService {
  preview(): Promise<BulkExcerptMergeDetectPreview>;
  run(
    options?: BulkExcerptMergeDetectRunOptions,
  ): Promise<BulkExcerptMergeDetectResult>;
}

export const BULK_EXCERPT_MERGE_DETECT_SERVICE_NAME = 'bulkExcerptMergeDetect';
export const BULK_EXCERPT_MERGE_DETECT_CAPABILITY = 'bulkExcerptMergeDetect@1';
