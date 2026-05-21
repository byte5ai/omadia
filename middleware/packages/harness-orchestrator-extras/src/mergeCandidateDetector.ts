/**
 * @omadia/orchestrator-extras — MergeCandidate Detector (KG-ACL Slice 10).
 *
 * Pipeline (one detect-pass per MK):
 *   1. Embed the source MK's `summary + rationale` (when the embedding
 *      column hasn't caught up yet — Slice-7 backfill is fire-and-
 *      forget post-COMMIT).
 *   2. searchMemorableKnowledgeByEmbedding → top-k similar MKs filtered
 *      to cosine ≥ minSimilarity (default 0.95), self-excluded.
 *   3. Per candidate: createMergeCandidate(mkA, mkB, cosineSim) —
 *      idempotent on the (sorted) pair, so a re-trigger or a
 *      back-and-forth A→B / B→A produces at most one MergeCandidate.
 *   4. At the end of a successful pass: markMemorableKnowledgeMergeChecked
 *      so the bulk job dedupes the source MK on the next sweep.
 *
 * Unlike the Slice-9 Inconsistency-Detector, this detector is
 * **cosine-only** — no Haiku judgement pass. At ≥ 0.95 the content
 * overlap is high enough that one is a refinement/restatement of the
 * other; the operator picks `keep_a` / `keep_b` / `not_duplicate`.
 *
 * Failure semantics: never throws. Errors logged on stderr.
 */

import type { EmbeddingClient } from '@omadia/embeddings';
import type {
  GraphNode,
  KnowledgeGraph,
  MemorableKnowledgeHit,
  MergeCandidateDetectorService,
} from '@omadia/plugin-api';

export interface MergeCandidateDetectorDeps {
  graph: KnowledgeGraph;
  /** Optional. Without an embedder the detector can't find candidates;
   *  `detectFor` returns 0/0. */
  embeddingClient?: EmbeddingClient;
  /** Cosine similarity floor for near-duplicate flagging. Default 0.95.
   *  Below 0.95 the content delta is usually meaningful (see Slice 9
   *  Inconsistency-Detector for the contradiction path). */
  minSimilarity?: number;
  /** Max candidates checked per source MK. Default 5. */
  topK?: number;
  log?: (msg: string) => void;
}

const DEFAULT_MIN_SIMILARITY = 0.95;
const DEFAULT_TOP_K = 5;

export function createMergeCandidateDetector(
  deps: MergeCandidateDetectorDeps,
): MergeCandidateDetectorService {
  const log =
    deps.log ?? ((msg: string): void => { console.error(msg); });
  const minSim = deps.minSimilarity ?? DEFAULT_MIN_SIMILARITY;
  const topK = deps.topK ?? DEFAULT_TOP_K;

  async function detectFor(
    memorableKnowledgeNodeId: string,
  ): Promise<{ candidatesScanned: number; mergeCandidatesCreated: number }> {
    if (!deps.embeddingClient) {
      return { candidatesScanned: 0, mergeCandidatesCreated: 0 };
    }
    let source: GraphNode | null;
    try {
      source = await deps.graph.getMemorableKnowledge(
        memorableKnowledgeNodeId,
      );
    } catch (err) {
      log(
        `[merge-detector] source lookup failed for ${memorableKnowledgeNodeId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { candidatesScanned: 0, mergeCandidatesCreated: 0 };
    }
    if (!source) return { candidatesScanned: 0, mergeCandidatesCreated: 0 };

    const owners = Array.isArray(source.props['acl_owners'])
      ? (source.props['acl_owners'] as string[])
      : [];
    if (owners.length === 0) {
      return { candidatesScanned: 0, mergeCandidatesCreated: 0 };
    }
    const viewer = owners[0]!;

    const sourceText = `${String(source.props['summary'] ?? '')}\n\n${String(source.props['rationale'] ?? '')}`.trim();
    if (sourceText.length === 0) {
      return { candidatesScanned: 0, mergeCandidatesCreated: 0 };
    }

    let queryVector: number[];
    try {
      queryVector = await deps.embeddingClient.embed(sourceText);
    } catch (err) {
      log(
        `[merge-detector] embed failed for ${memorableKnowledgeNodeId}: ${err instanceof Error ? err.message : String(err)} — skip`,
      );
      return { candidatesScanned: 0, mergeCandidatesCreated: 0 };
    }
    if (queryVector.length === 0) {
      return { candidatesScanned: 0, mergeCandidatesCreated: 0 };
    }

    let candidates: MemorableKnowledgeHit[];
    try {
      candidates = await deps.graph.searchMemorableKnowledgeByEmbedding({
        queryEmbedding: queryVector,
        viewerOmadiaUserId: viewer,
        limit: topK + 1,
        minSimilarity: minSim,
      });
    } catch (err) {
      log(
        `[merge-detector] candidate search failed for ${memorableKnowledgeNodeId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { candidatesScanned: 0, mergeCandidatesCreated: 0 };
    }

    const filtered = candidates
      .filter((c) => c.mk.id !== source.id)
      .slice(0, topK);
    let created = 0;

    for (const candidate of filtered) {
      try {
        const persisted = await deps.graph.createMergeCandidate({
          mkAExternalId: source.id,
          mkBExternalId: candidate.mk.id,
          cosineSim: candidate.cosineSim,
        });
        if (persisted) {
          created++;
          log(
            `[merge-detector] flagged ${source.id} vs ${candidate.mk.id} cosine=${candidate.cosineSim.toFixed(3)}`,
          );
        }
      } catch (err) {
        log(
          `[merge-detector] persist failed for ${source.id} vs ${candidate.mk.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // Mark the source as merge-checked. Same semantics as Slice 9.5
    // marker: success path only — embed-failure / search-failure
    // branches above leave the marker untouched so the next bulk
    // sweep retries.
    try {
      await deps.graph.markMemorableKnowledgeMergeChecked(source.id);
    } catch (err) {
      log(
        `[merge-detector] marker write failed for ${source.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return { candidatesScanned: filtered.length, mergeCandidatesCreated: created };
  }

  return { detectFor };
}
