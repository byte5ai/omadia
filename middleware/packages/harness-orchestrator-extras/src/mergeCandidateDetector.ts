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
  PalaiaExcerptHit,
} from '@omadia/plugin-api';

export interface MergeCandidateDetectorDeps {
  graph: KnowledgeGraph;
  /** Optional. Without an embedder the detector can't find candidates;
   *  `detectFor` / `detectForExcerpt` return 0/0. */
  embeddingClient?: EmbeddingClient;
  /** Cosine similarity floor for MK-level flagging. Default 0.95. */
  minSimilarity?: number;
  /** Slice 12 — Cosine similarity floor for Excerpt-level flagging.
   *  Higher than MK (default 0.97) because Excerpts are shorter +
   *  literaler — cosine clusters sharper. */
  excerptMinSimilarity?: number;
  /** Max candidates checked per source. Default 5. */
  topK?: number;
  /**
   * Auto-merge threshold. When set, a flagged MK pair whose cosine is at or
   * above this value is RESOLVED automatically (the duplicate is retired via
   * `resolveMergeCandidate`) instead of only being flagged for an operator —
   * so re-learned knowledge stops accumulating on any deployment without a
   * manual cleanup pass. SAFETY: a `manuallyAuthored` (durable) node is NEVER
   * deleted; when exactly one side is durable it always wins; when BOTH are
   * durable the pair is left for an operator; otherwise the OLDER node wins.
   * Undefined → auto-merge disabled (flag-only, legacy behaviour).
   */
  autoMergeThreshold?: number;
  log?: (msg: string) => void;
}

const DEFAULT_MIN_SIMILARITY = 0.95;
const DEFAULT_EXCERPT_MIN_SIMILARITY = 0.97;
const DEFAULT_TOP_K = 5;

export function createMergeCandidateDetector(
  deps: MergeCandidateDetectorDeps,
): MergeCandidateDetectorService {
  const log =
    deps.log ?? ((msg: string): void => { console.error(msg); });
  const minSim = deps.minSimilarity ?? DEFAULT_MIN_SIMILARITY;
  const excerptMinSim =
    deps.excerptMinSimilarity ?? DEFAULT_EXCERPT_MIN_SIMILARITY;
  const topK = deps.topK ?? DEFAULT_TOP_K;
  const autoMergeThreshold = deps.autoMergeThreshold;

  /**
   * Pick which of two near-duplicate MKs to KEEP, or null to leave for an
   * operator. Durable (`manuallyAuthored`) is sacred: it is never the loser,
   * and two durable nodes are never auto-merged. Otherwise the older node wins
   * (it's the established one; the fresh re-statement is the duplicate).
   */
  function decideKeeper(a: GraphNode, b: GraphNode): string | null {
    const aDur = a.manuallyAuthored === true;
    const bDur = b.manuallyAuthored === true;
    if (aDur && bDur) return null; // both curated — hands off
    if (aDur !== bDur) return aDur ? a.id : b.id; // the durable one wins
    const aAt = String(a.props['created_at'] ?? '');
    const bAt = String(b.props['created_at'] ?? '');
    if (aAt && bAt && aAt !== bAt) return aAt < bAt ? a.id : b.id; // older wins
    return b.id; // tie / unknown → keep the existing candidate, retire source
  }

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
          // Auto-merge: high-confidence + safe → retire the duplicate now so
          // re-learned knowledge stops accumulating without a manual sweep.
          if (
            autoMergeThreshold !== undefined &&
            candidate.cosineSim >= autoMergeThreshold
          ) {
            const keeper = decideKeeper(source, candidate.mk);
            if (keeper === null) {
              log(
                `[merge-detector] auto-merge SKIP ${source.id} vs ${candidate.mk.id}: both durable`,
              );
            } else {
              // duplicateOf is sorted ascending; keep_a keeps [0] (deletes [1]),
              // keep_b keeps [1] (deletes [0]).
              const resolution =
                persisted.duplicateOf[0] === keeper ? 'keep_a' : 'keep_b';
              try {
                await deps.graph.resolveMergeCandidate(
                  persisted.id,
                  resolution,
                  { actorOmadiaUserId: viewer },
                );
                log(
                  `[merge-detector] auto-merged cosine=${candidate.cosineSim.toFixed(3)} kept=${keeper} (retired the duplicate)`,
                );
              } catch (err) {
                log(
                  `[merge-detector] auto-merge FAILED for ${persisted.id} (left flagged): ${err instanceof Error ? err.message : String(err)}`,
                );
              }
            }
          }
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

  // ─── Slice 12 — Excerpt-level detect ──────────────────────────────

  async function detectForExcerpt(
    excerptExternalId: string,
  ): Promise<{
    candidatesScanned: number;
    excerptMergeCandidatesCreated: number;
  }> {
    if (!deps.embeddingClient) {
      return { candidatesScanned: 0, excerptMergeCandidatesCreated: 0 };
    }

    // Pull the source excerpt + its parent MK (used for ACL).
    let neighbors: GraphNode[];
    try {
      neighbors = await deps.graph.getNeighbors(excerptExternalId);
    } catch (err) {
      log(
        `[merge-detector-excerpt] neighbour lookup failed for ${excerptExternalId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { candidatesScanned: 0, excerptMergeCandidatesCreated: 0 };
    }
    const parentMk = neighbors.find((n) => n.type === 'MemorableKnowledge');
    const sourceExcerpt = (
      await deps.graph.listExcerptsForMemory(parentMk?.id ?? '')
    ).find((e) => e.id === excerptExternalId);
    if (!parentMk || !sourceExcerpt) {
      return { candidatesScanned: 0, excerptMergeCandidatesCreated: 0 };
    }

    const owners = Array.isArray(parentMk.props['acl_owners'])
      ? (parentMk.props['acl_owners'] as string[])
      : [];
    if (owners.length === 0) {
      return { candidatesScanned: 0, excerptMergeCandidatesCreated: 0 };
    }
    const viewer = owners[0]!;

    const sourceText = String(sourceExcerpt.props.text ?? '').trim();
    if (sourceText.length === 0) {
      return { candidatesScanned: 0, excerptMergeCandidatesCreated: 0 };
    }

    let queryVector: number[];
    try {
      queryVector = await deps.embeddingClient.embed(sourceText);
    } catch (err) {
      log(
        `[merge-detector-excerpt] embed failed for ${excerptExternalId}: ${err instanceof Error ? err.message : String(err)} — skip`,
      );
      return { candidatesScanned: 0, excerptMergeCandidatesCreated: 0 };
    }
    if (queryVector.length === 0) {
      return { candidatesScanned: 0, excerptMergeCandidatesCreated: 0 };
    }

    let candidates: PalaiaExcerptHit[];
    try {
      candidates = await deps.graph.searchExcerptsByEmbedding({
        queryEmbedding: queryVector,
        viewerOmadiaUserId: viewer,
        limit: topK + 1,
        minSimilarity: excerptMinSim,
      });
    } catch (err) {
      log(
        `[merge-detector-excerpt] candidate search failed for ${excerptExternalId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { candidatesScanned: 0, excerptMergeCandidatesCreated: 0 };
    }

    const filtered = candidates
      .filter((c) => c.excerpt.id !== sourceExcerpt.id)
      .slice(0, topK);
    let created = 0;

    for (const candidate of filtered) {
      try {
        const persisted = await deps.graph.createExcerptMergeCandidate({
          excerptAExternalId: sourceExcerpt.id,
          excerptBExternalId: candidate.excerpt.id,
          cosineSim: candidate.cosineSim,
        });
        if (persisted) {
          created++;
          log(
            `[merge-detector-excerpt] flagged ${sourceExcerpt.id} vs ${candidate.excerpt.id} cosine=${candidate.cosineSim.toFixed(3)}`,
          );
        }
      } catch (err) {
        log(
          `[merge-detector-excerpt] persist failed for ${sourceExcerpt.id} vs ${candidate.excerpt.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    try {
      await deps.graph.markPalaiaExcerptMergeChecked(sourceExcerpt.id);
    } catch (err) {
      log(
        `[merge-detector-excerpt] marker write failed for ${sourceExcerpt.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return {
      candidatesScanned: filtered.length,
      excerptMergeCandidatesCreated: created,
    };
  }

  return { detectFor, detectForExcerpt };
}
