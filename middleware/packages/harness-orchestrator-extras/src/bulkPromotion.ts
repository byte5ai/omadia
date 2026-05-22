/**
 * @omadia/orchestrator-extras — Bulk-Promotion (KG-ACL Slice 8).
 *
 * Retrospective two-phase pass over historical Turns:
 *   1. SCORE — Turns with `graph_nodes.significance IS NULL` go
 *      through the configured `SignificanceScorer` (Haiku). Writes
 *      the score back to the column. Skipped Turns (no scorer wired)
 *      surface as 503 from the route, not silent-skip here.
 *   2. PROMOTE — Turns with `significance >= threshold` that don't
 *      already have an attached MemorableKnowledge (DERIVED_FROM
 *      edge) go through the existing `promoteTurnIfSignificant`
 *      pipeline. Reuses the live-promotion path so manual + bulk
 *      MKs share their shape exactly.
 *
 * Both phases idempotent. Re-running only touches new rows.
 *
 * Cost guard: hard-caps both limits at 1000 per call. Operator can
 * iterate for larger corpora; the UI confirms anything > 50 so an
 * accidental Bulk-Promote can't burn through hundreds of Haiku calls.
 */

import type { Pool } from 'pg';
import type {
  BulkPromotePreview,
  BulkPromoteRunOptions,
  BulkPromoteRunResult,
  BulkPromotionService,
  KnowledgeGraph,
} from '@omadia/plugin-api';

import type { SignificanceScorer } from './captureFilter.js';
import { promoteTurnIfSignificant } from './promotion.js';

export interface BulkPromotionDeps {
  pool: Pool;
  tenantId: string;
  kg: KnowledgeGraph;
  /** Optional. When absent, `run` throws `{ code:
   *  'bulk.scorer_unavailable' }` and `preview` returns
   *  `scorerAvailable: false`. */
  scorer?: SignificanceScorer;
  /** Fallback threshold when caller didn't pass one. Default 0.7
   *  matches `KG_ACL_AUTO_PROMOTE_THRESHOLD` so manual + bulk + live
   *  promotion all decide identically. */
  defaultThreshold?: number;
  log?: (msg: string) => void;
}

const HARD_CAP = 1000;
const DEFAULT_LIMIT = 100;
const DEFAULT_THRESHOLD = 0.7;

function clampLimit(value: number | undefined): number {
  const v = typeof value === 'number' && Number.isFinite(value) ? value : DEFAULT_LIMIT;
  return Math.max(1, Math.min(v, HARD_CAP));
}

function clampThreshold(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(value, 1));
}

interface ScoreCandidate {
  external_id: string;
  user_message: string | null;
  assistant_answer: string | null;
}

interface PromoteCandidate {
  external_id: string;
  user_id: string | null;
  assistant_answer: string | null;
}

export function createBulkPromotionService(
  deps: BulkPromotionDeps,
): BulkPromotionService {
  const log = deps.log ?? ((msg: string): void => { console.error(msg); });
  const defaultThreshold = deps.defaultThreshold ?? DEFAULT_THRESHOLD;

  async function preview(threshold: number): Promise<BulkPromotePreview> {
    const th = clampThreshold(threshold, defaultThreshold);

    const [nullSig, eligible, alreadyPromoted] = await Promise.all([
      deps.pool.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM graph_nodes
          WHERE tenant_id = $1 AND type = 'Turn' AND significance IS NULL`,
        [deps.tenantId],
      ),
      deps.pool.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM graph_nodes t
          WHERE t.tenant_id = $1
            AND t.type = 'Turn'
            AND t.significance >= $2
            AND NOT EXISTS (
              SELECT 1 FROM graph_edges e
                JOIN graph_nodes mk ON mk.id = e.from_node
              WHERE e.tenant_id = $1
                AND e.to_node = t.id
                AND e.type = 'DERIVED_FROM'
                AND mk.type = 'MemorableKnowledge'
            )`,
        [deps.tenantId, th],
      ),
      deps.pool.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM graph_nodes t
          WHERE t.tenant_id = $1
            AND t.type = 'Turn'
            AND t.significance >= $2
            AND EXISTS (
              SELECT 1 FROM graph_edges e
                JOIN graph_nodes mk ON mk.id = e.from_node
              WHERE e.tenant_id = $1
                AND e.to_node = t.id
                AND e.type = 'DERIVED_FROM'
                AND mk.type = 'MemorableKnowledge'
            )`,
        [deps.tenantId, th],
      ),
    ]);

    return {
      nullSignificanceCount: Number(nullSig.rows[0]?.count ?? '0'),
      eligibleForPromoteCount: Number(eligible.rows[0]?.count ?? '0'),
      alreadyPromotedCount: Number(alreadyPromoted.rows[0]?.count ?? '0'),
      scorerAvailable: deps.scorer !== undefined,
      threshold: th,
    };
  }

  async function run(
    options: BulkPromoteRunOptions = {},
  ): Promise<BulkPromoteRunResult> {
    if (!deps.scorer) {
      throw Object.assign(new Error('SignificanceScorer not configured'), {
        code: 'bulk.scorer_unavailable',
      });
    }
    const startedAt = Date.now();
    const scoreLimit = clampLimit(options.scoreLimit);
    const promoteLimit = clampLimit(options.promoteLimit);
    const threshold = clampThreshold(options.threshold, defaultThreshold);

    // ─── Phase 1: SCORE ────────────────────────────────────────────
    const scoreRows = await deps.pool.query<ScoreCandidate>(
      `SELECT external_id,
              properties->>'userMessage'     AS user_message,
              properties->>'assistantAnswer' AS assistant_answer
         FROM graph_nodes
        WHERE tenant_id = $1
          AND type = 'Turn'
          AND significance IS NULL
        ORDER BY created_at ASC
        LIMIT $2`,
      [deps.tenantId, scoreLimit],
    );

    let scored = 0;
    let scoreFailed = 0;
    for (const row of scoreRows.rows) {
      const text = `${row.user_message ?? ''}\n\n${row.assistant_answer ?? ''}`.trim();
      if (text.length === 0) {
        scoreFailed++;
        continue;
      }
      try {
        const result = await deps.scorer.score(text);
        await deps.pool.query(
          `UPDATE graph_nodes
              SET significance = $1
            WHERE tenant_id = $2 AND external_id = $3 AND type = 'Turn'`,
          [result.score, deps.tenantId, row.external_id],
        );
        scored++;
      } catch (err) {
        scoreFailed++;
        const message = err instanceof Error ? err.message : String(err);
        log(`[bulk-promote] score failed turn=${row.external_id}: ${message}`);
      }
    }
    log(
      `[bulk-promote] score phase done scanned=${String(scoreRows.rows.length)} scored=${String(scored)} failed=${String(scoreFailed)}`,
    );

    // ─── Phase 2: PROMOTE ──────────────────────────────────────────
    const promoteRows = await deps.pool.query<PromoteCandidate>(
      `SELECT t.external_id,
              t.user_id,
              t.properties->>'assistantAnswer' AS assistant_answer
         FROM graph_nodes t
        WHERE t.tenant_id = $1
          AND t.type = 'Turn'
          AND t.significance >= $2
          AND t.user_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM graph_edges e
              JOIN graph_nodes mk ON mk.id = e.from_node
            WHERE e.tenant_id = $1
              AND e.to_node = t.id
              AND e.type = 'DERIVED_FROM'
              AND mk.type = 'MemorableKnowledge'
          )
        ORDER BY t.significance DESC, t.created_at ASC
        LIMIT $3`,
      [deps.tenantId, threshold, promoteLimit],
    );

    let promoted = 0;
    let alreadyPromoted = 0;
    let belowThreshold = 0;
    let promoteFailed = 0;
    for (const row of promoteRows.rows) {
      if (!row.user_id) {
        promoteFailed++;
        continue;
      }
      try {
        const result = await promoteTurnIfSignificant({
          pool: deps.pool,
          tenantId: deps.tenantId,
          kg: deps.kg,
          turnId: row.external_id,
          userId: row.user_id,
          threshold,
          fallbackAssistantAnswer: row.assistant_answer ?? '',
          log,
        });
        if (result.promoted) {
          promoted++;
        } else if (result.reason === 'already-promoted') {
          alreadyPromoted++;
        } else if (result.reason === 'below-threshold') {
          belowThreshold++;
        } else {
          promoteFailed++;
        }
      } catch (err) {
        promoteFailed++;
        const message = err instanceof Error ? err.message : String(err);
        log(`[bulk-promote] promote failed turn=${row.external_id}: ${message}`);
      }
    }
    log(
      `[bulk-promote] promote phase done scanned=${String(promoteRows.rows.length)} promoted=${String(promoted)} already=${String(alreadyPromoted)} below=${String(belowThreshold)} failed=${String(promoteFailed)}`,
    );

    return {
      scorePhase: {
        scanned: scoreRows.rows.length,
        scored,
        failed: scoreFailed,
      },
      promotePhase: {
        scanned: promoteRows.rows.length,
        promoted,
        alreadyPromoted,
        belowThreshold,
        failed: promoteFailed,
      },
      durationMs: Date.now() - startedAt,
    };
  }

  return { preview, run };
}
