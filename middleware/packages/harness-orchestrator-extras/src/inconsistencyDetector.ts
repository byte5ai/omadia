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

import type { LlmProvider, LlmResponse } from '@omadia/llm-provider';
import { collectText, textMessage } from '@omadia/llm-provider';
import type { EmbeddingClient } from '@omadia/embeddings';
import type {
  GraphNode,
  InconsistencyDetectorService,
  InconsistencySeverity,
  KnowledgeGraph,
  MemorableKnowledgeHit,
} from '@omadia/plugin-api';
import { INCONSISTENCY_MAX_LOST_VERDICTS, parseLlmJson } from '@omadia/plugin-api';

import type { OpenJobPrivacy } from './jobPrivacy.js';

export interface InconsistencyDetectorDeps {
  graph: KnowledgeGraph;
  /** Optional. Without an embedder the detector can't find candidates
   *  at all — service still publishes but `detectFor` returns 0/0. */
  embeddingClient?: EmbeddingClient;
  /** Optional. Without an Anthropic client the detector skips the
   *  judgement pass — `detectFor` returns the candidate count but
   *  creates 0 inconsistencies. */
  llm?: LlmProvider;
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
  /**
   * WP-10 — the Privacy Shield route for the memory pairs, which carry stored
   * real values. One run per `detectFor`; the judgement's reason is restored
   * before it is persisted. A run that cannot mask skips the pass and leaves
   * the memory unchecked, so a later sweep retries. Absent ⇒ the pairs go out
   * as stored.
   */
  privacy?: OpenJobPrivacy;
}

interface JudgementResult {
  compatible: 'yes' | 'no' | 'unclear';
  reason?: string;
  severity?: InconsistencySeverity;
}

const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
const DEFAULT_MIN_SIMILARITY = 0.7;
const DEFAULT_TOP_K = 5;
/**
 * #1861 — output budget of one judgement. The prompt allows a 200-character
 * reason inside a JSON object; in German that alone can pass 100 tokens, and
 * the old cap of 200 cut verdicts off inside `reason`. 500 leaves room for the
 * longest answer the prompt asks for.
 */
export const JUDGEMENT_MAX_TOKENS = 500;

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
  // #1527 — tolerates a ```json fence with text around it (shared parser).
  const parsed = parseLlmJson(raw) as Partial<JudgementResult> | undefined;
  if (parsed && typeof parsed === 'object') {
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
    if (!deps.embeddingClient || !deps.llm) {
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
    const run = deps.privacy?.('inconsistency-detector');
    // #1861 — a verdict that was lost (failed call, unparseable or cut-off
    // reply) leaves the entry unchecked, so the next bulk sweep judges it again.
    let verdictLost = false;

    for (const candidate of filtered) {
      const request = buildUserMessage(source, candidate.mk);
      const masked = run ? await run.mask(request) : { send: true as const, text: request };
      if (!masked.send) {
        // Like a failed embed: no marker, so the bulk sweep retries later.
        log(
          `[inconsistency] privacy: ${masked.reason} — pass skipped for ${memorableKnowledgeNodeId}`,
        );
        return { candidatesScanned: 0, inconsistenciesCreated: created };
      }
      let response: LlmResponse;
      try {
        response = await deps.llm.complete({
          model,
          maxTokens: JUDGEMENT_MAX_TOKENS,
          system: PROMPT,
          messages: [textMessage('user', masked.text)],
        });
      } catch (err) {
        log(
          `[inconsistency] judgement Haiku call failed for ${memorableKnowledgeNodeId} vs ${candidate.mk.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
        verdictLost = true;
        continue;
      }
      const text = collectText(response.content);
      const judgement = parseJudgement(text);
      if (!judgement) {
        const why =
          response.finishReason === 'max_tokens'
            ? ` (cut off at max_tokens=${String(JUDGEMENT_MAX_TOKENS)})`
            : '';
        log(
          `[inconsistency] unparseable judgement${why} for ${memorableKnowledgeNodeId} vs ${candidate.mk.id}: ${text.slice(0, 120)}`,
        );
        verdictLost = true;
        continue;
      }
      if (judgement.compatible !== 'no') continue;

      const severity = judgement.severity ?? 'medium';
      const reason =
        judgement.reason !== undefined && run
          ? await run.restore(judgement.reason)
          : judgement.reason;
      const summary =
        reason ??
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

    // Slice 9.5 — bump the marker last, and only after every candidate got a
    // verdict. The embed-call / search-call early-returns above leave the
    // marker untouched so the bulk job retries on the next sweep; #1861 — a
    // lost verdict does the same, otherwise the pair would never be judged
    // again (the bulk check only picks entries without the marker). Pairs
    // already flagged are idempotent on re-run.
    if (verdictLost) {
      // ADR-0190 — record the lost attempt; after
      // INCONSISTENCY_MAX_LOST_VERDICTS the provider gives up on the entry
      // so a pair that never gets a verdict stops blocking the queue.
      try {
        await deps.graph.markMemorableKnowledgeInconsistencyChecked(source.id, {
          verdictLost: true,
        });
      } catch (err) {
        log(
          `[inconsistency] attempt write failed for ${source.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      log(
        `[inconsistency] ${memorableKnowledgeNodeId} left unchecked: at least one verdict was lost — retried on a later sweep (gives up after ${String(INCONSISTENCY_MAX_LOST_VERDICTS)} lost passes)`,
      );
      return { candidatesScanned: filtered.length, inconsistenciesCreated: created };
    }
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
