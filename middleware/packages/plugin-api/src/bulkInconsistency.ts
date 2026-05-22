/**
 * @omadia/plugin-api — Bulk Inconsistency Detect capability (Slice 9.5).
 *
 * Slice 9 detects contradictions live (on createMemorableKnowledge /
 * updateMemorableKnowledge / auto-promotion). Memories that predate
 * Slice 9 (or predate Slice 7, before they had embeddings) were never
 * checked. Slice 9.5 lets the operator trigger the existing detector
 * over MemorableKnowledge rows that
 *   (a) have an embedding (cosine candidate-search can find neighbours)
 *   (b) carry no `last_inconsistency_check_at` marker yet
 *
 * Idempotent — the marker is written by `detectFor()` at the end of
 * each run, so a re-trigger only does work for unchecked MKs. The
 * marker is shared with the live detector path: when the live trigger
 * sets it on a freshly mutated MK, the bulk job skips that MK on its
 * next sweep.
 */

export interface BulkInconsistencyPreview {
  /** MKs with an embedding and NO `last_inconsistency_check_at`
   *  marker — i.e. would be processed by a run. */
  unchecked: number;
  /** MKs that already carry the marker (any status). */
  alreadyChecked: number;
  /** MKs without an embedding column populated yet — skipped by both
   *  the bulk job and the live detector. The Slice-7 embedding
   *  backfill eventually populates them, after which the next bulk
   *  run picks them up. */
  withoutEmbedding: number;
  /** False when the detector lacks an Anthropic client (e.g. no
   *  `anthropic_api_key` configured). `run()` returns 503-equivalent
   *  via the route layer when this is false. */
  detectorAvailable: boolean;
}

export interface BulkInconsistencyRunOptions {
  /** Max MKs processed per call. Hard-capped at 200. Default 25. The
   *  cost-guard floor: at top-k=5 a single MK triggers up to 5 Haiku
   *  judgement calls, so the worst-case run is ~1000 Haiku calls
   *  (≈$2-5 at Haiku-4.5 pricing). */
  limit?: number;
}

export interface BulkInconsistencyResult {
  /** MKs returned by the selection query. */
  scanned: number;
  /** MKs successfully checked — `last_inconsistency_check_at` was set
   *  for all of these. Always equal to `scanned - failed`. */
  checked: number;
  /** Inconsistency nodes the detector flagged across this run. Idempotent
   *  on the (sorted) MK pair, so re-runs over the same MKs produce 0. */
  inconsistenciesCreated: number;
  /** MKs skipped because their embedding wasn't ready yet. Subset of
   *  `scanned` — only included when the selection query is widened to
   *  also surface no-embedding MKs (current implementation excludes
   *  them, so this is 0 unless the index goes stale mid-run). */
  skippedNoEmbedding: number;
  /** MKs whose detectFor threw — marker NOT set, so the next bulk
   *  run picks them up again. */
  failed: number;
  /** Wall-clock duration of the run. */
  durationMs: number;
}

/**
 * Service surface published by the bulk-inconsistency provider.
 * `preview()` is always callable. `run()` throws
 * `{ code: 'bulk.detector_unavailable' }` when the configured detector
 * doesn't have an Anthropic client (the live-trigger Haiku-judgement
 * pass is what costs money — without it, the run would just walk MKs
 * and write markers with no judgement).
 */
export interface BulkInconsistencyService {
  preview(): Promise<BulkInconsistencyPreview>;
  run(options?: BulkInconsistencyRunOptions): Promise<BulkInconsistencyResult>;
}

export const BULK_INCONSISTENCY_SERVICE_NAME = 'bulkInconsistencyDetect';
export const BULK_INCONSISTENCY_CAPABILITY = 'bulkInconsistencyDetect@1';
