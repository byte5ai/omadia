/**
 * @omadia/orchestrator-extras — Scratchpad-Promotion Reaper (WS5).
 *
 * Periodic background job that consolidates significant, AGED agent-scratch
 * memory (the PostgresMemoryStore `memory_files` table, physical layout
 * `/memories/orchestrators/<slug>/…`) into the Knowledge-Graph as
 * MemorableKnowledge.
 *
 * Flow per `runOnce()`:
 *   1. SELECT aged agent-scratch rows (updated_at older than `ageMs`,
 *      virtual_path under `/memories/orchestrators/%`). If the table does
 *      not exist (PostgresMemoryStore not active / migration not applied),
 *      catch + no-op.
 *   2. For each row: derive the orchestrator/agent slug from the path,
 *      score the `content` with the SignificanceScorer. If the score is
 *      >= threshold AND the content is non-trivial, materialise a
 *      MemorableKnowledge node (`kind=insight`) stamped with
 *      `originAgent=<slug>`, `createdBy='scratch-reaper'` and
 *      `visibility='team'`, THEN delete the scratch row. Delete happens
 *      ONLY after a successful create, so a failed promotion leaves the
 *      scratch intact for the next run.
 *   3. Aged rows that are NOT promoted (sub-threshold or trivial/too-short)
 *      are left untouched by default. When `dropUnpromoted` is enabled they
 *      are hard-deleted from `memory_files` instead (true TTL of stale
 *      scratch). The two branches are mutually exclusive — a row is never
 *      both promoted (which already deletes it) and dropped.
 *
 * Visibility: promoted scratch is published TEAM-VISIBLE (`visibility:
 * 'team'`) so consolidated agent knowledge is shareable across the team
 * rather than admin-only. `aclOwners` stays `[]` — team visibility, not the
 * owner list, is what makes the MK recallable team-wide. Scratch memory is
 * not user-attributed (it is the orchestrator's own scratchpad), so there
 * are no `involvedOmadiaUserIds`. `defaultVisibility` (the dep) is carried
 * for telemetry/log parity with the capture-filter.
 *
 * Failure semantics: per-row failures are logged and skipped — the run
 * never throws. `runOnce` returns
 * `{ scanned, promoted, skipped, dropped, failed }`.
 */

import type { Pool } from 'pg';
import type { KnowledgeGraph, MemorableKind, Visibility } from '@omadia/plugin-api';

import type { SignificanceScorer } from './captureFilter.js';

/** Physical prefix of the agent-scratch tree inside `memory_files`. */
const SCRATCH_PREFIX = '/memories/orchestrators/';

/** Max chars persisted into the MK `summary` headline. */
const MAX_SUMMARY_LEN = 500;

/** Below this trimmed length a scratch body is "trivial" and never
 *  promoted regardless of the scorer (an empty/whitespace note carries no
 *  recall value and we don't want to burn an MK on it). */
const MIN_NON_TRIVIAL_LEN = 16;

/** Default per-run batch ceiling — keeps a single tick bounded. */
const DEFAULT_BATCH = 50;

/** MK kind for an insight-type consolidation. */
const REAPER_MK_KIND: MemorableKind = 'insight';

export interface ScratchPromotionReaperDeps {
  pool: Pool;
  /** Reserved for future tenant-scoped scratch trees. `memory_files` is
   *  currently single-tenant (no tenant_id column), so this is carried for
   *  log parity / forward-compat and not used in the WHERE clause. */
  tenantId: string;
  kg: KnowledgeGraph;
  scorer: SignificanceScorer;
  /** Significance score required to promote (inclusive). */
  threshold: number;
  /** A scratch row is eligible once `updated_at < now() - ageMs`. */
  ageMs: number;
  /** `setInterval` cadence for `start()`. Required for the background loop;
   *  `runOnce()` works standalone without it (used by tests). */
  intervalMs: number;
  /** Default visibility — telemetry only (see file header). */
  defaultVisibility: Visibility;
  /**
   * Opt-in destructive TTL: when true, aged scratch rows that are NOT
   * promoted (sub-threshold OR trivial/too-short) are hard-deleted from
   * `memory_files`. Default false — non-promoted scratch is never destroyed.
   */
  dropUnpromoted?: boolean;
  /** Per-run batch ceiling. Default 50. */
  batchSize?: number;
  log?: (msg: string) => void;
}

export interface ScratchReapRunResult {
  /** Rows pulled from `memory_files` this run. */
  scanned: number;
  /** Rows promoted to MemorableKnowledge + deleted from scratch. */
  promoted: number;
  /** Rows left untouched (below threshold or trivial, `dropUnpromoted`
   *  off). */
  skipped: number;
  /** Non-promoted aged rows hard-deleted (only when `dropUnpromoted`). */
  dropped: number;
  /** Rows that errored (score/create/delete) — left intact for next run. */
  failed: number;
}

export interface ScratchPromotionReaper {
  /** Start the interval. No-op if already started. */
  start(): void;
  /** Stop the interval. Safe to call when not started. */
  stop(): void;
  /** Run a single consolidation pass. Never throws. */
  runOnce(): Promise<ScratchReapRunResult>;
}

interface ScratchRow {
  virtual_path: string;
  content: string;
}

/** Derive the orchestrator/agent slug from a scratch virtual path.
 *  `/memories/orchestrators/<slug>/note.md` → `<slug>`. Returns the empty
 *  string when the path doesn't carry a slug segment (defensive). */
export function deriveAgentSlug(virtualPath: string): string {
  if (!virtualPath.startsWith(SCRATCH_PREFIX)) return '';
  const rest = virtualPath.slice(SCRATCH_PREFIX.length);
  const slash = rest.indexOf('/');
  const slug = slash === -1 ? rest : rest.slice(0, slash);
  return slug.trim();
}

/** Build a recall-friendly headline from a scratch body — collapse
 *  whitespace, trim to `MAX_SUMMARY_LEN` with an ellipsis. */
function deriveSummary(content: string): string {
  const flat = content.trim().replace(/\s+/g, ' ');
  if (flat.length <= MAX_SUMMARY_LEN) return flat;
  return `${flat.slice(0, MAX_SUMMARY_LEN - 1).trimEnd()}…`;
}

export function createScratchPromotionReaper(
  deps: ScratchPromotionReaperDeps,
): ScratchPromotionReaper {
  const log = deps.log ?? ((msg: string): void => { console.error(msg); });
  const batchSize =
    typeof deps.batchSize === 'number' && Number.isFinite(deps.batchSize)
      ? Math.max(1, Math.floor(deps.batchSize))
      : DEFAULT_BATCH;

  // Interval handle. Module-private; never leaks.
  let timer: ReturnType<typeof setInterval> | undefined;

  async function runOnce(): Promise<ScratchReapRunResult> {
    const result: ScratchReapRunResult = {
      scanned: 0,
      promoted: 0,
      skipped: 0,
      dropped: 0,
      failed: 0,
    };

    let rows: ScratchRow[];
    try {
      // `make_interval(secs => …)` keeps the age window a bound parameter
      // (no string interpolation into SQL). `text_pattern_ops` index on
      // virtual_path serves the LIKE prefix scan.
      const ageSeconds = Math.max(0, deps.ageMs) / 1000;
      const res = await deps.pool.query<ScratchRow>(
        `SELECT virtual_path, content
           FROM memory_files
          WHERE virtual_path LIKE $1
            AND updated_at < now() - make_interval(secs => $2)
          ORDER BY updated_at ASC
          LIMIT $3`,
        [`${SCRATCH_PREFIX}%`, ageSeconds, batchSize],
      );
      rows = res.rows;
    } catch (err) {
      // PostgresMemoryStore not active (table absent) or DB down — no-op.
      // `42P01 = undefined_table`; any other error is also non-fatal for a
      // background reaper, so we log + return empty counts either way.
      const message = err instanceof Error ? err.message : String(err);
      log(`[scratch-reaper] scan skipped (memory_files unavailable): ${message}`);
      return result;
    }

    result.scanned = rows.length;

    // Reap a NON-promoted aged row: when `dropUnpromoted` is on, hard-delete
    // it (true TTL) and count it as dropped; otherwise leave it untouched
    // and count it as skipped (historical default). Mutually exclusive with
    // the promotion branch, which deletes the row itself.
    const reapUnpromoted = async (virtualPath: string): Promise<void> => {
      if (deps.dropUnpromoted) {
        await deps.pool.query(
          `DELETE FROM memory_files WHERE virtual_path = $1`,
          [virtualPath],
        );
        result.dropped++;
        log(`[scratch-reaper] dropped path=${virtualPath} (unpromoted, ttl)`);
      } else {
        result.skipped++;
      }
    };

    for (const row of rows) {
      try {
        const slug = deriveAgentSlug(row.virtual_path);
        const trimmed = row.content.trim();

        if (trimmed.length < MIN_NON_TRIVIAL_LEN) {
          await reapUnpromoted(row.virtual_path);
          continue;
        }

        const { score } = await deps.scorer.score(trimmed);
        if (score < deps.threshold) {
          await reapUnpromoted(row.virtual_path);
          continue;
        }

        // Promote: agent-scoped, TEAM-VISIBLE MemorableKnowledge. aclOwners=[]
        // (scratch isn't user-attributed) — visibility='team' is what makes
        // the consolidated knowledge shareable team-wide. originAgent = the
        // orchestrator slug so recall can still attribute it to that Agent.
        await deps.kg.createMemorableKnowledge({
          kind: REAPER_MK_KIND,
          summary: deriveSummary(row.content),
          significance: score,
          createdBy: 'scratch-reaper',
          involvedOmadiaUserIds: [],
          aclOwners: [],
          visibility: 'team',
          ...(slug ? { originAgent: slug } : {}),
        });

        // Delete ONLY after a successful create — a failed promote (caught
        // below) leaves the scratch row intact for the next interval.
        await deps.pool.query(
          `DELETE FROM memory_files WHERE virtual_path = $1`,
          [row.virtual_path],
        );

        result.promoted++;
        log(
          `[scratch-reaper] promoted path=${row.virtual_path} agent=${slug || '(none)'} score=${score.toFixed(2)}`,
        );
      } catch (err) {
        result.failed++;
        const message = err instanceof Error ? err.message : String(err);
        log(`[scratch-reaper] FAIL path=${row.virtual_path}: ${message}`);
        // continue — never throw the run.
      }
    }

    log(
      `[scratch-reaper] run done scanned=${String(result.scanned)} promoted=${String(result.promoted)} skipped=${String(result.skipped)} dropped=${String(result.dropped)} failed=${String(result.failed)}`,
    );
    return result;
  }

  return {
    start(): void {
      if (timer) return;
      const ms =
        deps.intervalMs > 0 ? deps.intervalMs : 60 * 60 * 1000;
      timer = setInterval(() => {
        void runOnce();
      }, ms);
      // Don't keep the event loop alive solely for the reaper.
      if (typeof timer.unref === 'function') timer.unref();
    },
    stop(): void {
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
    },
    runOnce,
  };
}
