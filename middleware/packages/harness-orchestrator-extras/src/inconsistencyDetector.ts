/**
 * @omadia/orchestrator-extras — Contradiction Detector (KG-ACL Slice 9).
 *
 * Pipeline (one detect-pass per MK):
 *   1. Embed the source MK's `summary + rationale` (the embedding
 *      column on the row may not have caught up yet — Slice-7 backfill
 *      is fire-and-forget post-COMMIT). When the live embed call
 *      fails the detector skips silently; the periodic re-detect
 *      (defer) will pick it up later.
 *   2. searchMemorableKnowledgeByEmbedding → top-k similar MKs
 *      (default cosine ≥ 0.7, k=5), self-excluded.
 *   3. Per candidate: Haiku JSON-mode pass — `{compatible: yes|no|
 *      unclear, reason, severity}`. Only `compatible='no'` triggers
 *      persistence; `unclear` is treated as a low-confidence skip.
 *   4. createInconsistency(mkA, mkB, summary, severity) — idempotent
 *      on the (sorted) pair, so a re-trigger or a back-and-forth
 *      A→B / B→A produces at most one Inconsistency.
 *
 * Failure semantics: never throws. Errors logged on stderr; the live
 * mutation pipeline is never blocked by a degraded detector.
 */

import type Anthropic from '@anthropic-ai/sdk';
import type { EmbeddingClient } from '@omadia/embeddings';
import type {
  GraphNode,
  InconsistencyDetectorService,
  InconsistencySeverity,
  KnowledgeGraph,
  MemorableKnowledgeHit,
} from '@omadia/plugin-api';

export interface InconsistencyDetectorDeps {
  graph: KnowledgeGraph;
  /** Optional. Without an embedder the detector can't find candidates
   *  at all — service still publishes but `detectFor` returns 0/0. */
  embeddingClient?: EmbeddingClient;
  /** Optional. Without an Anthropic client the detector skips the
   *  judgement pass — `detectFor` returns the candidate count but
   *  creates 0 inconsistencies. */
  anthropic?: Anthropic;
  /** Haiku model id. Default 'claude-haiku-4-5-20251001' to match the
   *  fact-extractor / significance-scorer / excerpt-extractor. */
  model?: string;
  /** Cosine similarity floor for candidate selection. Lower than the
   *  Slice-7 recall threshold (0.5) because we WANT to catch borderline
   *  cases — the Haiku judgement filters out false positives. Default
   *  0.7. */
  minSimilarity?: number;
  /** Max candidates checked per source MK. Default 5. */
  topK?: number;
  log?: (msg: string) => void;
}

interface JudgementResult {
  compatible: 'yes' | 'no' | 'unclear';
  reason?: string;
  severity?: InconsistencySeverity;
}

const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
const DEFAULT_MIN_SIMILARITY = 0.7;
const DEFAULT_TOP_K = 5;

const PROMPT = `You compare two MemorableKnowledge entries that the embedding similarity flagged as related. Decide whether they are factually CONSISTENT or contradict each other.

Reply with ONLY a single-line JSON object, no prose, no code fences.

Schema:
{"compatible": "yes" | "no" | "unclear", "reason": "<≤200 chars>", "severity": "low" | "medium" | "high"}

Rules:
- "yes": both can be true at the same time, or one is a refinement / restatement of the other
- "no": they make incompatible factual claims about the same thing
- "unclear": same topic but you can't tell if they conflict (low-confidence; will be skipped)
- "severity" only required when compatible="no". low=cosmetic, medium=actionable, high=blocks correct decisions
- "reason" required when compatible!="yes". Briefly explain WHAT contradicts.`;

function buildUserMessage(a: GraphNode, b: GraphNode): string {
  const aSummary = String(a.props['summary'] ?? '');
  const aRationale = String(a.props['rationale'] ?? '');
  const aKind = String(a.props['kind'] ?? 'memory');
  const bSummary = String(b.props['summary'] ?? '');
  const bRationale = String(b.props['rationale'] ?? '');
  const bKind = String(b.props['kind'] ?? 'memory');
  return `Memory A (${aKind}):\nSummary: ${aSummary}\nRationale: ${aRationale}\n\nMemory B (${bKind}):\nSummary: ${bSummary}\nRationale: ${bRationale}`;
}

function parseJudgement(raw: string): JudgementResult | null {
  const trimmed = raw.trim();
  // Strip code fences if Haiku included them despite the prompt.
  const stripped = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '');
  try {
    const parsed = JSON.parse(stripped) as Partial<JudgementResult>;
    if (
      parsed.compatible === 'yes' ||
      parsed.compatible === 'no' ||
      parsed.compatible === 'unclear'
    ) {
      const severityOk =
        parsed.severity === undefined ||
        parsed.severity === 'low' ||
        parsed.severity === 'medium' ||
        parsed.severity === 'high';
      if (!severityOk) return null;
      return {
        compatible: parsed.compatible,
        ...(parsed.reason ? { reason: String(parsed.reason).slice(0, 1000) } : {}),
        ...(parsed.severity ? { severity: parsed.severity } : {}),
      };
    }
  } catch {
    return null;
  }
  return null;
}

export function createInconsistencyDetector(
  deps: InconsistencyDetectorDeps,
): InconsistencyDetectorService {
  const log =
    deps.log ?? ((msg: string): void => { console.error(msg); });
  const model = deps.model ?? DEFAULT_MODEL;
  const minSim = deps.minSimilarity ?? DEFAULT_MIN_SIMILARITY;
  const topK = deps.topK ?? DEFAULT_TOP_K;

  async function detectFor(
    memorableKnowledgeNodeId: string,
  ): Promise<{ candidatesScanned: number; inconsistenciesCreated: number }> {
    if (!deps.embeddingClient || !deps.anthropic) {
      return { candidatesScanned: 0, inconsistenciesCreated: 0 };
    }
    let source: GraphNode | null;
    try {
      source = await deps.graph.getMemorableKnowledge(
        memorableKnowledgeNodeId,
      );
    } catch (err) {
      log(
        `[inconsistency] source lookup failed for ${memorableKnowledgeNodeId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { candidatesScanned: 0, inconsistenciesCreated: 0 };
    }
    if (!source) return { candidatesScanned: 0, inconsistenciesCreated: 0 };

    const owners = Array.isArray(source.props['acl_owners'])
      ? (source.props['acl_owners'] as string[])
      : [];
    if (owners.length === 0) {
      // Admin-only invisible MK — search would always hit empty owner-
      // sets; nothing to compare against.
      return { candidatesScanned: 0, inconsistenciesCreated: 0 };
    }
    const viewer = owners[0]!;

    const sourceText = `${String(source.props['summary'] ?? '')}\n\n${String(source.props['rationale'] ?? '')}`.trim();
    if (sourceText.length === 0) {
      return { candidatesScanned: 0, inconsistenciesCreated: 0 };
    }

    let queryVector: number[];
    try {
      queryVector = await deps.embeddingClient.embed(sourceText);
    } catch (err) {
      log(
        `[inconsistency] embed failed for ${memorableKnowledgeNodeId}: ${err instanceof Error ? err.message : String(err)} — skip`,
      );
      return { candidatesScanned: 0, inconsistenciesCreated: 0 };
    }
    if (queryVector.length === 0) {
      return { candidatesScanned: 0, inconsistenciesCreated: 0 };
    }

    let candidates: MemorableKnowledgeHit[];
    try {
      candidates = await deps.graph.searchMemorableKnowledgeByEmbedding({
        queryEmbedding: queryVector,
        viewerOmadiaUserId: viewer,
        limit: topK + 1, // overshoot: source itself is in the result, drop it
        minSimilarity: minSim,
      });
    } catch (err) {
      log(
        `[inconsistency] candidate search failed for ${memorableKnowledgeNodeId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { candidatesScanned: 0, inconsistenciesCreated: 0 };
    }

    const filtered = candidates.filter((c) => c.mk.id !== source.id).slice(0, topK);
    let created = 0;

    for (const candidate of filtered) {
      let response;
      try {
        response = await deps.anthropic.messages.create({
          model,
          max_tokens: 200,
          system: PROMPT,
          messages: [{ role: 'user', content: buildUserMessage(source, candidate.mk) }],
        });
      } catch (err) {
        log(
          `[inconsistency] judgement Haiku call failed for ${memorableKnowledgeNodeId} vs ${candidate.mk.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }
      const block = response.content[0];
      const text =
        block && block.type === 'text' ? block.text : '';
      const judgement = parseJudgement(text);
      if (!judgement) {
        log(
          `[inconsistency] unparseable judgement for ${memorableKnowledgeNodeId} vs ${candidate.mk.id}: ${text.slice(0, 120)}`,
        );
        continue;
      }
      if (judgement.compatible !== 'no') continue;

      const severity = judgement.severity ?? 'medium';
      const summary =
        judgement.reason ??
        `Inconsistency between two memories (cosine=${candidate.cosineSim.toFixed(2)})`;

      try {
        const persisted = await deps.graph.createInconsistency({
          mkAExternalId: source.id,
          mkBExternalId: candidate.mk.id,
          summary,
          severity,
        });
        if (persisted) {
          created++;
          log(
            `[inconsistency] flagged ${source.id} vs ${candidate.mk.id} severity=${severity}`,
          );
        }
      } catch (err) {
        log(
          `[inconsistency] persist failed for ${source.id} vs ${candidate.mk.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // Slice 9.5 — bump the marker last. We only reach this point after a
    // full pass over the candidate window completed (the embed-call /
    // search-call early-returns above leave the marker untouched on
    // purpose, so the bulk job retries on the next sweep). A judgement-
    // call failure on a single candidate still counts as "checked" —
    // we made our best effort against the rest, no point in re-running
    // the whole top-k.
    try {
      await deps.graph.markMemorableKnowledgeInconsistencyChecked(source.id);
    } catch (err) {
      log(
        `[inconsistency] marker write failed for ${source.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return { candidatesScanned: filtered.length, inconsistenciesCreated: created };
  }

  return { detectFor };
}
