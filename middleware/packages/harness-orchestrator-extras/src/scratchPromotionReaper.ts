/**
 * @omadia/orchestrator-extras — Scratchpad-Promotion Reaper (WS5).
 *
 * Consolidates significant, AGED agent-scratch memory (the
 * PostgresMemoryStore `memory_files` table, physical layout
 * `/memories/orchestrators/<slug>/…`) into the Knowledge-Graph as
 * MemorableKnowledge.
 *
 * #2082 (spec 2042 §5.12) — it no longer runs on its own interval. It is a
 * `BatchJob` (`asBatchJob`) the kernel runs as a bounded batch trigger owned
 * by the agent whose scratch it is: due rows are counted without a model
 * (`due`), a firing handles at most one batch of that agent's rows under the
 * trigger's deadline, budget and breaker.
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
 *      `visibility='private'`, THEN delete the scratch row. Delete happens
 *      ONLY after a successful create, so a failed promotion leaves the
 *      scratch intact for the next run.
 *   3. Aged rows that are NOT promoted (sub-threshold or trivial/too-short)
 *      are left untouched by default. When `dropUnpromoted` is enabled they
 *      are hard-deleted from `memory_files` instead (true TTL of stale
 *      scratch). The two branches are mutually exclusive — a row is never
 *      both promoted (which already deletes it) and dropped.
 *
 * Visibility (#2082, spec 2042 §5.12): promoted scratch stays the agent's
 * own — `visibility: 'private'`, `originAgent` = the agent, origin labels
 * (`unprotected`) kept. Nothing is published as team knowledge by default.
 * `aclOwners` stays `[]`: scratch memory is not user-attributed (it is the
 * orchestrator's own scratchpad), so there are no `involvedOmadiaUserIds`.
 * `defaultVisibility` (the dep) is carried for telemetry/log parity with
 * the capture-filter.
 *
 * Failure semantics: per-row failures are logged and skipped — the run
 * never throws. `runOnce` returns
 * `{ scanned, promoted, skipped, dropped, failed }`.
 */

import type { Pool } from 'pg';
import type { BatchJob, KnowledgeGraph, MemorableKind, Visibility } from '@omadia/plugin-api';

import type { SignificanceScorer } from './captureFilter.js';
import { isUnprotectedNote, stripUnprotectedNoteMarker } from './noteProvenance.js';

/** A plugin's `ctx.memory` tree inside an agent's scratch tree (#1540). */
const PLUGIN_MEMORY_PATH = /^\/memories\/orchestrators\/[^/]+\/plugins\//;

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

/** The batch job id the kernel knows this reaper by. */
export const SCRATCH_PROMOTION_JOB_ID = 'orchestrator-extras.scratch-promotion';

/** `LIKE` prefix of one agent's scratch tree (slug metacharacters escaped). */
export function agentScratchPrefix(agentSlug: string): string {
  return `${SCRATCH_PREFIX}${agentSlug.replace(/[\\%_]/g, (c) => `\\${c}`)}/`;
}

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
  /** How often the kernel may run the batch job for one agent. */
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

/** One agent's batch: its scratch tree only, at most `limit` rows. */
export interface ScratchReapScope {
  readonly agentSlug: string;
  readonly limit: number;
  readonly signal?: AbortSignal;
}

export interface ScratchPromotionReaper {
  /** Run a single consolidation pass (all agents, or one agent's batch).
   *  Never throws. */
  runOnce(scope?: ScratchReapScope): Promise<ScratchReapRunResult>;
  /** Aged rows of one agent's scratch tree, counted without a model. */
  due(agentSlug: string): Promise<number>;
  /** This reaper as the kernel batch job (spec 2042 §5.12). */
  asBatchJob(): BatchJob;
}

interface ScratchRow {
  virtual_path: string;
  content: string;
  updated_at: Date;
}

/** Rows kept in memory as already scored below the threshold. */
const MAX_EVALUATED = 10_000;

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

  const ageSeconds = Math.max(0, deps.ageMs) / 1000;

  // #2082 — rows scored below the threshold and left in place (no
  // `dropUnpromoted`): path → the `updated_at` they were scored at. They are
  // not due again until written again, so `due` reaches 0 and a run does not
  // re-score the same oldest rows forever. In memory: a restart scores them
  // once more.
  const evaluated = new Map<string, number>();
  const remember = (row: ScratchRow): void => {
    evaluated.delete(row.virtual_path);
    evaluated.set(row.virtual_path, row.updated_at.getTime());
    while (evaluated.size > MAX_EVALUATED) {
      const oldest = evaluated.keys().next().value;
      if (oldest === undefined) break;
      evaluated.delete(oldest);
    }
  };
  const notEvaluated = (): [string[], Date[]] => [
    [...evaluated.keys()],
    [...evaluated.values()].map((ms) => new Date(ms)),
  ];
  // Compared at millisecond precision: that is what a JS Date keeps.
  const NOT_EVALUATED_SQL = `(virtual_path, date_trunc('milliseconds', updated_at)) NOT IN (SELECT * FROM unnest($3::text[], $4::timestamptz[]))`;

  async function due(agentSlug: string): Promise<number> {
    try {
      const [paths, stamps] = notEvaluated();
      const res = await deps.pool.query<{ n: string }>(
        `SELECT count(*)::text AS n
           FROM memory_files
          WHERE virtual_path LIKE $1
            AND updated_at < now() - make_interval(secs => $2)
            AND ${NOT_EVALUATED_SQL}`,
        [`${agentScratchPrefix(agentSlug)}%`, ageSeconds, paths, stamps],
      );
      return Number(res.rows[0]?.n ?? 0);
    } catch {
      // memory_files unavailable: nothing is due.
      return 0;
    }
  }

  async function runOnce(scope?: ScratchReapScope): Promise<ScratchReapRunResult> {
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
      const prefix = scope ? agentScratchPrefix(scope.agentSlug) : SCRATCH_PREFIX;
      const limit = scope ? Math.max(1, Math.min(scope.limit, batchSize)) : batchSize;
      const [paths, stamps] = notEvaluated();
      const res = await deps.pool.query<ScratchRow>(
        `SELECT virtual_path, content, updated_at
           FROM memory_files
          WHERE virtual_path LIKE $1
            AND updated_at < now() - make_interval(secs => $2)
            AND ${NOT_EVALUATED_SQL}
          ORDER BY updated_at ASC
          LIMIT $5`,
        [`${prefix}%`, ageSeconds, paths, stamps, limit],
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
    const reapUnpromoted = async (row: ScratchRow): Promise<void> => {
      if (deps.dropUnpromoted) {
        await deps.pool.query(
          `DELETE FROM memory_files WHERE virtual_path = $1`,
          [row.virtual_path],
        );
        result.dropped++;
        log(`[scratch-reaper] dropped path=${row.virtual_path} (unpromoted, ttl)`);
      } else {
        result.skipped++;
        remember(row);
      }
    };

    for (const row of rows) {
      if (scope?.signal?.aborted) break;
      try {
        const slug = deriveAgentSlug(row.virtual_path);
        // #1540 — a note written in an unprotected turn: score and summarise
        // it without the marker line, and stamp the memory `unprotected`. A
        // plugin's own `ctx.memory` file holds what the plugin fetched in
        // clear, whatever the turn: always `unprotected`.
        const unprotected =
          isUnprotectedNote(row.content) || PLUGIN_MEMORY_PATH.test(row.virtual_path);
        const content = stripUnprotectedNoteMarker(row.content);
        const trimmed = content.trim();

        if (trimmed.length < MIN_NON_TRIVIAL_LEN) {
          await reapUnpromoted(row);
          continue;
        }

        const { score } = await deps.scorer.score(trimmed);
        if (score < deps.threshold) {
          await reapUnpromoted(row);
          continue;
        }

        // Promote: the agent's own MemorableKnowledge (#2082 — never team
        // knowledge by default). aclOwners=[] (scratch isn't
        // user-attributed); originAgent = the orchestrator slug.
        await deps.kg.createMemorableKnowledge({
          kind: REAPER_MK_KIND,
          summary: deriveSummary(content),
          significance: score,
          createdBy: 'scratch-reaper',
          involvedOmadiaUserIds: [],
          aclOwners: [],
          visibility: 'private',
          ...(slug ? { originAgent: slug } : {}),
          ...(unprotected ? { unprotected: true } : {}),
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
    runOnce,
    due,
    asBatchJob(): BatchJob {
      return {
        id: SCRATCH_PROMOTION_JOB_ID,
        purpose: 'Consolidate significant aged scratch notes into durable memory',
        intervalMinutes: Math.max(1, Math.round(deps.intervalMs / 60_000)),
        batchSize,
        due,
        async run(agentSlug, options) {
          const r = await runOnce({ agentSlug, limit: options.limit, signal: options.signal });
          return { processed: r.promoted + r.dropped + r.skipped, failed: r.failed };
        },
      };
    },
  };
}
