/**
 * @omadia/orchestrator-extras — Bulk MergeCandidate Detect (KG-ACL Slice 10).
 *
 * Operator-triggered pass over MemorableKnowledge rows that
 *   (a) have an embedding (cosine candidate-search can find neighbours)
 *   (b) carry no `last_merge_check_at` marker yet
 *
 * For each MK in the selection window we call the existing
 * `MergeCandidateDetectorService.detectFor()`. The detector writes the
 * marker at the end of every successful run, so a re-trigger only does
 * work for MKs whose previous detectFor threw.
 *
 * Unlike Slice 9.5 there is NO judgement-availability gate: the
 * detector is cosine-only and works as long as an embedding-client +
 * the KG itself are available. The cost-cap reflects this: 500 MKs
 * per call (vs. 200 for Slice 9.5) because there's no per-Haiku spend.
 */

import type {
  BulkMergeDetectPreview,
  BulkMergeDetectResult,
  BulkMergeDetectRunOptions,
  BulkMergeDetectService,
  KnowledgeGraph,
  MergeCandidateDetectorService,
} from '@omadia/plugin-api';

export interface BulkMergeDetectDeps {
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

export function createBulkMergeDetectService(
  deps: BulkMergeDetectDeps,
): BulkMergeDetectService {
  const log = deps.log ?? ((msg: string): void => { console.error(msg); });

  async function preview(): Promise<BulkMergeDetectPreview> {
    const buckets = await deps.kg.countMemorableKnowledgeMergeCheckBuckets();
    return {
      unchecked: buckets.unchecked,
      alreadyChecked: buckets.alreadyChecked,
      withoutEmbedding: buckets.withoutEmbedding,
      // cosine-only — no external dependency to gate on.
      detectorAvailable: true,
    };
  }

  async function run(
    options: BulkMergeDetectRunOptions = {},
  ): Promise<BulkMergeDetectResult> {
    const startedAt = Date.now();
    const limit = clampLimit(options.limit);

    const ids = await deps.kg.listMemorableKnowledgeIdsForBulkMergeCheck({
      limit,
    });

    let checked = 0;
    let mergeCandidatesCreated = 0;
    let skippedNoEmbedding = 0;
    let failed = 0;

    for (const mkId of ids) {
      try {
        const stats = await deps.detector.detectFor(mkId);
        mergeCandidatesCreated += stats.mergeCandidatesCreated;
        if (stats.candidatesScanned === 0 && stats.mergeCandidatesCreated === 0) {
          // Same telemetry trick as Slice 9.5: detectFor's early-return
          // branches don't write the marker, so we can disambiguate
          // "actual no-candidates" from "skipped because no embedding".
          const mk = await deps.kg.getMemorableKnowledge(mkId);
          if (mk && mk.props['last_merge_check_at'] === undefined) {
            skippedNoEmbedding++;
            continue;
          }
        }
        checked++;
      } catch (err) {
        failed++;
        const message = err instanceof Error ? err.message : String(err);
        log(`[bulk-merge-detect] detectFor failed mk=${mkId}: ${message}`);
      }
    }

    const durationMs = Date.now() - startedAt;
    log(
      `[bulk-merge-detect] run done scanned=${String(ids.length)} checked=${String(checked)} mergeCandidates=${String(mergeCandidatesCreated)} skippedNoEmbedding=${String(skippedNoEmbedding)} failed=${String(failed)} durationMs=${String(durationMs)}`,
    );

    return {
      scanned: ids.length,
      checked,
      mergeCandidatesCreated,
      skippedNoEmbedding,
      failed,
      durationMs,
    };
  }

  return { preview, run };
}
