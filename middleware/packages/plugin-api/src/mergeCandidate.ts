/**
 * @omadia/plugin-api — MergeCandidate capability (KG-ACL Slice 10).
 *
 * Two MemorableKnowledge nodes whose cosine similarity is ≥ 0.95 are
 * near-duplicates: they don't contradict each other (Slice 9 catches
 * contradictions), they are essentially the same statement said twice.
 * The detector persists each such pair as a `MergeCandidate` node with
 * two `DUPLICATE_OF` edges (one per offending MK) and surfaces them in
 * `/admin/duplicates` for operator-resolve.
 *
 * Detection is **cosine-only** — no Haiku judgement pass. At ≥ 0.95 the
 * content overlap is high enough that one is a refinement / restatement
 * of the other. Operator picks `keep_a` / `keep_b` / `not_duplicate`.
 */

export type MergeCandidateStatus = 'open' | 'resolved' | 'dismissed';

export type MergeCandidateResolution =
  /** Memory A is the keeper → memory B is deleted via deleteMemory. */
  | 'keep_a'
  /** Memory B is the keeper → memory A is deleted via deleteMemory. */
  | 'keep_b'
  /** Detector overshot — these aren't actually duplicates. */
  | 'not_duplicate';

export interface MergeCandidateNode {
  /** External id, scheme `merge:<uuid>`. */
  id: string;
  type: 'MergeCandidate';
  props: {
    /** Cosine similarity captured at detect-time, in [0.95, 1.0]. */
    cosine_sim: number;
    status: MergeCandidateStatus;
    resolution: MergeCandidateResolution | null;
    created_at: string;
    resolved_at: string | null;
    /** Cluster-root that resolved the candidate; null while open. */
    resolved_by: string | null;
  };
  /** External ids of the two near-duplicate MKs, sorted ascending so
   *  dedupe-checks are direction-independent (mirrors Slice 9). */
  duplicateOf: [string, string];
}

export interface ListMergeCandidatesOptions {
  viewerOmadiaUserId: string;
  status?: MergeCandidateStatus;
  /** Clamped to [1, 200]. Default 50. */
  limit?: number;
}

export interface CreateMergeCandidateInput {
  mkAExternalId: string;
  mkBExternalId: string;
  /** Cosine similarity at detect-time. Should be ≥ 0.95; the storage
   *  layer doesn't enforce a floor — the detector's job to filter. */
  cosineSim: number;
}

/**
 * Service surface published by the merge-detector provider. Mirrors
 * `InconsistencyDetectorService` from Slice 9. Slice 12 added the
 * `detectForExcerpt` entry-point so the same detector handles both
 * MK- and Excerpt-level near-duplicate flagging.
 */
export interface MergeCandidateDetectorService {
  detectFor(memorableKnowledgeNodeId: string): Promise<{
    candidatesScanned: number;
    mergeCandidatesCreated: number;
  }>;
  /**
   * Slice 12 — run the near-duplicate pass for a single Excerpt
   * instead of an MK. Produces `ExcerptMergeCandidate` nodes (not
   * `MergeCandidate`); count returned under
   * `excerptMergeCandidatesCreated`.
   */
  detectForExcerpt(excerptExternalId: string): Promise<{
    candidatesScanned: number;
    excerptMergeCandidatesCreated: number;
  }>;
}

export const MERGE_CANDIDATE_DETECTOR_SERVICE_NAME = 'mergeCandidateDetector';
export const MERGE_CANDIDATE_DETECTOR_CAPABILITY = 'mergeCandidateDetector@1';

// ─── Slice 10 · Bulk Merge Detect (parallel to Slice 9.5) ──────────────

export interface BulkMergeDetectPreview {
  unchecked: number;
  alreadyChecked: number;
  withoutEmbedding: number;
  /** Always `true` — the cosine-only detector has no external dependency
   *  to gate on. Field is preserved for shape-parity with
   *  `BulkInconsistencyPreview`; consumers can treat the two payloads
   *  uniformly in the admin UI. */
  detectorAvailable: boolean;
}

export interface BulkMergeDetectRunOptions {
  /** Max MKs processed per call. Hard-capped at 500 (higher than
   *  Slice 9.5 because cosine is cost-free). Default 50. */
  limit?: number;
}

export interface BulkMergeDetectResult {
  scanned: number;
  checked: number;
  mergeCandidatesCreated: number;
  skippedNoEmbedding: number;
  failed: number;
  durationMs: number;
}

export interface BulkMergeDetectService {
  preview(): Promise<BulkMergeDetectPreview>;
  run(options?: BulkMergeDetectRunOptions): Promise<BulkMergeDetectResult>;
}

export const BULK_MERGE_DETECT_SERVICE_NAME = 'bulkMergeDetect';
export const BULK_MERGE_DETECT_CAPABILITY = 'bulkMergeDetect@1';
