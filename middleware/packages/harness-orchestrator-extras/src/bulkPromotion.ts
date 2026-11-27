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
 * ADR-0190 — bulk promotion creates entries exactly like live
 * auto-promotion: it requires an excerpt when an extractor is installed (the
 * extractor runs here, masked through the stored-text privacy scope), stamps
 * the producing Agent from the turn's qualified scope as `origin_agent`, and
 * keeps member-scoped turns with their owners. It never touches a turn
 * retired from promotion (an entry derived from it was deleted, discarded or
 * merged away) or a turn no person owns (Public API `key:<id>` turns, #1864):
 * both are left out of the candidate list and the "eligible" count, so the
 * promote limit is spent only on turns that can be promoted.
 *
 * Cost guard: hard-caps both limits at 1000 per call. Operator can
 * iterate for larger corpora; the UI confirms anything > 50 so an
 * accidental Bulk-Promote can't burn through hundreds of Haiku calls.
 */

import type { Pool } from 'pg';
import { AGENT_SCOPE_SEP, PROMOTION_RETIRED_PROP } from '@omadia/plugin-api';
import type {
  BulkPromotePreview,
  BulkPromoteRunOptions,
  BulkPromoteRunResult,
  BulkPromotionService,
  KnowledgeGraph,
  PalaiaExcerpt,
  PalaiaExcerptExtractor,
} from '@omadia/plugin-api';

import type { SignificanceScorer } from './captureFilter.js';
import {
  OMADIA_USER_ID_SQL,
  promoteTurnIfSignificant,
  retireTurnFromPromotion,
  type PromoteTurnResult,
} from './promotion.js';

export interface BulkPromotionDeps {
  pool: Pool;
  tenantId: string;
  kg: KnowledgeGraph;
  /** Optional. When absent, `run` throws `{ code:
   *  'bulk.scorer_unavailable' }` and `preview` returns
   *  `scorerAvailable: false`. */
  scorer?: SignificanceScorer;
  /**
   * ADR-0190 — the same excerpt extractor live auto-promotion uses, built
   * with the stored-text privacy scope (the turns hold real values). Set ⇒
   * every promotion needs an excerpt (`excerptRequired`), as live.
   */
  excerptExtractor?: PalaiaExcerptExtractor;
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
  scope: string | null;
  owners: unknown;
  user_message: string | null;
  assistant_answer: string | null;
}

/**
 * ADR-0190 — the conditions every bulk candidate meets, shared by the
 * preview counts and the promote query (`t` = the Turn row, `$1` = tenant).
 */
const PROMOTABLE_TURN_SQL = `
            -- #1096 — tail-only Turns are conversation, not knowledge.
            COALESCE((t.properties->>'tailOnly')::boolean, FALSE) = FALSE
            -- ADR-0190 (#1819) — an entry derived from it was deleted,
            -- discarded or merged away, or the turn proved unpromotable.
            AND NOT (t.properties ? '${PROMOTION_RETIRED_PROP}')
            -- ADR-0190 (#1864) — only people own memorable knowledge.
            AND t.user_id ${OMADIA_USER_ID_SQL}`;

const HAS_PROMOTED_MK_SQL = `EXISTS (
              SELECT 1 FROM graph_edges e
                JOIN graph_nodes mk ON mk.id = e.from_node
              WHERE e.tenant_id = $1
                AND e.to_node = t.id
                AND e.type = 'DERIVED_FROM'
                AND mk.type = 'MemorableKnowledge'
            )`;

/** The Agent a qualified turn scope (`<agentSlug>::<conversation>`) names. */
export function agentOfTurnScope(scope: string | null): string | undefined {
  if (!scope) return undefined;
  const at = scope.indexOf(AGENT_SCOPE_SEP);
  return at > 0 ? scope.slice(0, at) : undefined;
}

function ownersOf(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw.filter((x): x is string => typeof x === 'string');
}

interface PromoteTally {
  promoted: number;
  already: number;
  below: number;
  skipped: number;
  failed: number;
}

function countOutcome(tally: PromoteTally, result: PromoteTurnResult): void {
  switch (result.reason) {
    case 'promoted':
      tally.promoted++;
      return;
    case 'already-promoted':
      tally.already++;
      return;
    case 'below-threshold':
      tally.below++;
      return;
    case 'error':
    case 'missing-turn':
      tally.failed++;
      return;
    default:
      // retired, no-person-owner, no-owners, no-excerpt, hygiene-skip, …:
      // left alone on purpose, not a failure (ADR-0190).
      tally.skipped++;
  }
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
          WHERE tenant_id = $1 AND type = 'Turn' AND significance IS NULL
            AND COALESCE((properties->>'tailOnly')::boolean, FALSE) = FALSE`,
        [deps.tenantId],
      ),
      deps.pool.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM graph_nodes t
          WHERE t.tenant_id = $1
            AND t.type = 'Turn'
            AND t.significance >= $2
            AND ${PROMOTABLE_TURN_SQL}
            AND NOT ${HAS_PROMOTED_MK_SQL}`,
        [deps.tenantId, th],
      ),
      deps.pool.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM graph_nodes t
          WHERE t.tenant_id = $1
            AND t.type = 'Turn'
            AND t.significance >= $2
            AND COALESCE((t.properties->>'tailOnly')::boolean, FALSE) = FALSE
            AND ${HAS_PROMOTED_MK_SQL}`,
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

  /** One candidate through the live promotion path, with the live inputs. */
  async function promoteCandidate(
    row: PromoteCandidate,
    threshold: number,
  ): Promise<PromoteTurnResult> {
    const answer = row.assistant_answer ?? '';
    const excerpt = await extractExcerpt(row.user_message ?? '', answer);
    const owners = ownersOf(row.owners);
    const originAgent = agentOfTurnScope(row.scope);
    return promoteTurnIfSignificant({
      pool: deps.pool,
      tenantId: deps.tenantId,
      kg: deps.kg,
      turnId: row.external_id,
      userId: row.user_id ?? '',
      threshold,
      fallbackAssistantAnswer: answer,
      ...(owners !== undefined ? { owners } : {}),
      ...(originAgent !== undefined ? { originAgent } : {}),
      ...(excerpt ? { palaiaExcerpt: excerpt } : {}),
      excerptRequired: deps.excerptExtractor !== undefined,
      log,
    });
  }

  async function extractExcerpt(
    userMessage: string,
    answer: string,
  ): Promise<PalaiaExcerpt | undefined> {
    if (!deps.excerptExtractor) return undefined;
    try {
      return await deps.excerptExtractor.extract({
        cleanedUserMessage: userMessage,
        cleanedAssistantAnswer: answer,
      });
    } catch (err) {
      log(
        `[bulk-promote] excerpt failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return undefined;
    }
  }

  /**
   * ADR-0190 — outcomes that will not change on a later run retire the turn,
   * so it does not take a slot of the promote limit again.
   */
  async function retireIfFinal(
    turnId: string,
    result: PromoteTurnResult,
  ): Promise<void> {
    const reason =
      result.reason === 'no-person-owner' || result.reason === 'no-owners'
        ? 'no_person_owner'
        : result.reason === 'hygiene-skip'
          ? 'hygiene'
          : undefined;
    if (reason === undefined) return;
    await retireTurnFromPromotion(deps.pool, deps.tenantId, turnId, reason);
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
          -- #1096 — scoring a tail-only Turn would only make it eligible for
          -- the promote phase; it is deliberately not a knowledge candidate.
          AND COALESCE((properties->>'tailOnly')::boolean, FALSE) = FALSE
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
              t.scope,
              t.properties->'owners'          AS owners,
              t.properties->>'userMessage'     AS user_message,
              t.properties->>'assistantAnswer' AS assistant_answer
         FROM graph_nodes t
        WHERE t.tenant_id = $1
          AND t.type = 'Turn'
          AND t.significance >= $2
          AND ${PROMOTABLE_TURN_SQL}
          AND NOT ${HAS_PROMOTED_MK_SQL}
        ORDER BY t.significance DESC, t.created_at ASC
        LIMIT $3`,
      [deps.tenantId, threshold, promoteLimit],
    );

    const tally = { promoted: 0, already: 0, below: 0, skipped: 0, failed: 0 };
    for (const row of promoteRows.rows) {
      try {
        // #2294 — the live path's discretion check, before any LLM call.
        if (!(await mayPromote(options, row))) {
          tally.skipped++;
          log(`[discretion] bulk promotion of turn ${row.external_id} skipped: the turn carries another conversation's knowledge`);
          // Retired, or every later run would pick the same high-significance
          // turns first and spend its whole promote limit on them.
          await retireTurnFromPromotion(deps.pool, deps.tenantId, row.external_id, 'discretion');
          continue;
        }
        const result = await promoteCandidate(row, threshold);
        countOutcome(tally, result);
        await retireIfFinal(row.external_id, result);
      } catch (err) {
        tally.failed++;
        const message = err instanceof Error ? err.message : String(err);
        log(`[bulk-promote] promote failed turn=${row.external_id}: ${message}`);
      }
    }
    log(
      `[bulk-promote] promote phase done scanned=${String(promoteRows.rows.length)} promoted=${String(tally.promoted)} already=${String(tally.already)} below=${String(tally.below)} skipped=${String(tally.skipped)} failed=${String(tally.failed)}`,
    );

    return {
      scorePhase: {
        scanned: scoreRows.rows.length,
        scored,
        failed: scoreFailed,
      },
      promotePhase: {
        scanned: promoteRows.rows.length,
        promoted: tally.promoted,
        alreadyPromoted: tally.already,
        belowThreshold: tally.below,
        skipped: tally.skipped,
        failed: tally.failed,
      },
      durationMs: Date.now() - startedAt,
    };
  }

  return { preview, run };
}

/** #2294 — the kernel's discretion gate for one candidate; a throw refuses. */
async function mayPromote(options: BulkPromoteRunOptions, row: PromoteCandidate): Promise<boolean> {
  if (!options.mayPromote) return true;
  const owners = ownersOf(row.owners);
  const agentSlug = agentOfTurnScope(row.scope);
  try {
    return await options.mayPromote({
      turnId: row.external_id,
      ...(owners !== undefined ? { owners } : {}),
      ...(agentSlug !== undefined ? { agentSlug } : {}),
    });
  } catch {
    return false;
  }
}
