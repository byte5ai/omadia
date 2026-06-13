/**
 * @omadia/orchestrator-extras — Bulk Inconsistency Detect (KG-ACL Slice 9.5).
 *
 * Operator-triggered pass over MemorableKnowledge rows that
 *   (a) have an embedding (cosine candidate-search can find neighbours)
 *   (b) carry no `last_inconsistency_check_at` marker yet
 *
 * For each MK in the selection window we call the existing
 * `InconsistencyDetectorService.detectFor()`. The detector itself
 * writes the marker at the end of every successful run (whether 0 or N
 * Inconsistencies were created), so a re-trigger only does work for
 * MKs whose previous detectFor threw.
 *
 * Cost guard: limit hard-capped at 200. The route layer adds a
 * UI-confirm when the operator requests > 25 (top-k=5 means a single
 * MK can cost up to 5 Haiku judgement calls).
 */

import type {
  BulkInconsistencyPreview,
  BulkInconsistencyResult,
  BulkInconsistencyRunOptions,
  BulkInconsistencyService,
  InconsistencyDetectorService,
  KnowledgeGraph,
} from '@omadia/plugin-api';

export interface BulkInconsistencyDeps {
  kg: KnowledgeGraph;
  /** Optional. When absent, `run` throws
   *  `{ code: 'bulk.detector_unavailable' }` and `preview` returns
   *  `detectorAvailable: false`. Same shape as Slice-8 `bulk.scorer_unavailable`. */
  detector?: InconsistencyDetectorService;
  /** True if the detector's LLM judgement pass is wired. Mirrors
   *  the detector's runtime state — used by `preview()` to surface the
   *  503-gate condition. Defaults to `detector !== undefined` for the
   *  common case, but the plugin can override (e.g. when a detector
   *  was constructed but lacks an `llm` provider). */
  judgementAvailable?: boolean;
  log?: (msg: string) => void;
}

const HARD_CAP = 200;
const DEFAULT_LIMIT = 25;

function clampLimit(value: number | undefined): number {
  const v = typeof value === 'number' && Number.isFinite(value) ? value : DEFAULT_LIMIT;
  return Math.max(1, Math.min(v, HARD_CAP));
}

export function createBulkInconsistencyService(
  deps: BulkInconsistencyDeps,
): BulkInconsistencyService {
  const log = deps.log ?? ((msg: string): void => { console.error(msg); });
  const judgementAvailable =
    deps.judgementAvailable !== undefined
      ? deps.judgementAvailable
      : deps.detector !== undefined;

  async function preview(): Promise<BulkInconsistencyPreview> {
    const buckets = await deps.kg.countMemorableKnowledgeInconsistencyCheckBuckets();
    return {
      unchecked: buckets.unchecked,
      alreadyChecked: buckets.alreadyChecked,
      withoutEmbedding: buckets.withoutEmbedding,
      detectorAvailable: judgementAvailable,
    };
  }

  async function run(
    options: BulkInconsistencyRunOptions = {},
  ): Promise<BulkInconsistencyResult> {
    if (!deps.detector || !judgementAvailable) {
      throw Object.assign(new Error('InconsistencyDetector not configured'), {
        code: 'bulk.detector_unavailable',
      });
    }
    const startedAt = Date.now();
    const limit = clampLimit(options.limit);

    const ids = await deps.kg.listMemorableKnowledgeIdsForBulkInconsistencyCheck({
      limit,
    });

    let checked = 0;
    let inconsistenciesCreated = 0;
    let skippedNoEmbedding = 0;
    let failed = 0;

    for (const mkId of ids) {
      try {
        const stats = await deps.detector.detectFor(mkId);
        inconsistenciesCreated += stats.inconsistenciesCreated;
        // detectFor returns `candidatesScanned: 0` for the early-return
        // branches (no embedding, embed-call failure, owner-less MK).
        // Those leave the marker untouched on purpose so the next
        // bulk sweep retries — count them as failures so the operator
        // sees a non-zero `failed` when the embedding-backfill
        // hasn't caught up yet.
        if (stats.candidatesScanned === 0 && stats.inconsistenciesCreated === 0) {
          // Distinguish "no embedding yet" from "embedding present but
          // no candidates passed the similarity floor". The marker is
          // the source of truth: detectFor sets it when it reached the
          // end of its run. We re-fetch the MK quickly to check.
          const mk = await deps.kg.getMemorableKnowledge(mkId);
          if (mk && mk.props['last_inconsistency_check_at'] === undefined) {
            skippedNoEmbedding++;
            continue;
          }
        }
        checked++;
      } catch (err) {
        failed++;
        const message = err instanceof Error ? err.message : String(err);
        log(`[bulk-inconsistency] detectFor failed mk=${mkId}: ${message}`);
      }
    }

    const durationMs = Date.now() - startedAt;
    log(
      `[bulk-inconsistency] run done scanned=${String(ids.length)} checked=${String(checked)} inconsistencies=${String(inconsistenciesCreated)} skippedNoEmbedding=${String(skippedNoEmbedding)} failed=${String(failed)} durationMs=${String(durationMs)}`,
    );

    return {
      scanned: ids.length,
      checked,
      inconsistenciesCreated,
      skippedNoEmbedding,
      failed,
      durationMs,
    };
  }

  return { preview, run };
}
