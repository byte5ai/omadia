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
 *      `originAgent=<slug>` and `createdBy='scratch-reaper'`, THEN delete
 *      the scratch row. Delete happens ONLY after a successful create, so
 *      a failed promotion leaves the scratch intact for the next run.
 *   3. Below-threshold rows are left untouched (NO destructive drop by
 *      default).
 *
 * Failure semantics: per-row failures are logged and skipped — the run
 * never throws. `runOnce` returns `{ scanned, promoted, skipped, failed }`.
 *
 * ACL/visibility note: scratch memory is not user-attributed (it is the
 * orchestrator's own scratchpad, not a turn owned by an omadia user). We
 * therefore create the MK with `aclOwners: []` and no
 * `involvedOmadiaUserIds` — exactly the "admin-only" snapshot the KG-ACL
 * model assigns to owner-less MK. `defaultVisibility` is carried for
 * telemetry/log parity with the capture-filter; visibility on a
 * MemorableKnowledge is governed by its owners (empty owners → admin-only),
 * not a column on the ingest shape.
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
  /** Per-run batch ceiling. Default 50. */
  batchSize?: number;
  log?: (msg: string) => void;
}

export interface ScratchReapRunResult {
  /** Rows pulled from `memory_files` this run. */
  scanned: number;
  /** Rows promoted to MemorableKnowledge + deleted from scratch. */
  promoted: number;
  /** Rows left untouched (below threshold or trivial). */
  skipped: number;
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

    for (const row of rows) {
      try {
        const slug = deriveAgentSlug(row.virtual_path);
        const trimmed = row.content.trim();

        if (trimmed.length < MIN_NON_TRIVIAL_LEN) {
          result.skipped++;
          continue;
        }

        const { score } = await deps.scorer.score(trimmed);
        if (score < deps.threshold) {
          result.skipped++;
          continue;
        }

        // Promote: owner-less, agent-scoped MemorableKnowledge. aclOwners=[]
        // (admin-only snapshot — scratch isn't user-attributed), originAgent
        // = the orchestrator slug so recall default-isolates it to that
        // Agent.
        await deps.kg.createMemorableKnowledge({
          kind: REAPER_MK_KIND,
          summary: deriveSummary(row.content),
          significance: score,
          createdBy: 'scratch-reaper',
          involvedOmadiaUserIds: [],
          aclOwners: [],
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
      `[scratch-reaper] run done scanned=${String(result.scanned)} promoted=${String(result.promoted)} skipped=${String(result.skipped)} failed=${String(result.failed)}`,
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
