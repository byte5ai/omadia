/**
 * @omadia/orchestrator-extras — Bulk Excerpt Merge Detect (KG-ACL Slice 12).
 *
 * Operator-triggered pass over PalaiaExcerpt rows that
 *   (a) have an embedding (cosine candidate-search can find neighbours)
 *   (b) carry no `last_excerpt_merge_check_at` marker yet
 *
 * For each excerpt in the selection window we call the existing
 * `MergeCandidateDetectorService.detectForExcerpt()`. The detector
 * writes the marker at the end of every successful run, so a
 * re-trigger only does work for excerpts whose previous detectForExcerpt
 * threw.
 *
 * No Anthropic dependency — cosine-only detection. Hard-cap 500 per
 * call (cosine is cost-free).
 */

import type {
  BulkExcerptMergeDetectPreview,
  BulkExcerptMergeDetectResult,
  BulkExcerptMergeDetectRunOptions,
  BulkExcerptMergeDetectService,
  KnowledgeGraph,
  MergeCandidateDetectorService,
} from '@omadia/plugin-api';

export interface BulkExcerptMergeDetectDeps {
  kg: KnowledgeGraph;
  detector: MergeCandidateDetectorService;
  log?: (msg: string) => void;
}

const HARD_CAP = 500;
const DEFAULT_LIMIT = 50;

function clampLimit(value: number | undefined): number {
  const v = typeof value === 'number' && Number.isFinite(value) ? value : DEFAULT_LIMIT;
  return Math.max(1, Math.min(v, HARD_CAP));
}

export function createBulkExcerptMergeDetectService(
  deps: BulkExcerptMergeDetectDeps,
): BulkExcerptMergeDetectService {
  const log = deps.log ?? ((msg: string): void => { console.error(msg); });

  async function preview(): Promise<BulkExcerptMergeDetectPreview> {
    const buckets = await deps.kg.countPalaiaExcerptMergeCheckBuckets();
    return {
      unchecked: buckets.unchecked,
      alreadyChecked: buckets.alreadyChecked,
      withoutEmbedding: buckets.withoutEmbedding,
      detectorAvailable: true,
    };
  }

  async function run(
    options: BulkExcerptMergeDetectRunOptions = {},
  ): Promise<BulkExcerptMergeDetectResult> {
    const startedAt = Date.now();
    const limit = clampLimit(options.limit);

    const ids = await deps.kg.listPalaiaExcerptIdsForBulkMergeCheck({ limit });

    let checked = 0;
    let excerptMergeCandidatesCreated = 0;
    // Always 0 at this level — kept for stats-shape parity with Slice 10.
    const skippedNoEmbedding = 0;
    let failed = 0;

    for (const excerptId of ids) {
      try {
        const stats = await deps.detector.detectForExcerpt(excerptId);
        excerptMergeCandidatesCreated += stats.excerptMergeCandidatesCreated;
        // The selection-query already filters on `embedding IS NOT NULL`,
        // so we expect the marker-set path in detectForExcerpt to hit.
        // No skippedNoEmbedding-disambiguation needed at this level —
        // the operator can re-run the bulk if individual rows weren't
        // marked (their marker stays NULL, the next sweep retries).
        checked++;
      } catch (err) {
        failed++;
        const message = err instanceof Error ? err.message : String(err);
        log(`[bulk-excerpt-merge] detectForExcerpt failed ex=${excerptId}: ${message}`);
      }
    }

    const durationMs = Date.now() - startedAt;
    log(
      `[bulk-excerpt-merge] run done scanned=${String(ids.length)} checked=${String(checked)} excerptMergeCandidates=${String(excerptMergeCandidatesCreated)} skippedNoEmbedding=${String(skippedNoEmbedding)} failed=${String(failed)} durationMs=${String(durationMs)}`,
    );

    return {
      scanned: ids.length,
      checked,
      excerptMergeCandidatesCreated,
      skippedNoEmbedding,
      failed,
      durationMs,
    };
  }

  return { preview, run };
}
