/**
 * Process-level singleton that persists LLM token-usage rows to the shared
 * Neon Postgres `token_usage` table (created by graph migration 0028).
 *
 * Design constraints:
 *  - **Never throw into the caller.** Telemetry is observational; a DB hiccup
 *    must not break a chat turn. All writes are fire-and-forget with swallowed
 *    (once-logged) errors.
 *  - **Non-blocking hot path.** `recordUsage` buffers in memory and flushes on
 *    an interval / size threshold, so the orchestrator never awaits a DB round
 *    trip mid-stream.
 *  - **No-op until wired.** Before `initUsageRecorder(pool)` runs — or in
 *    in-memory-KG mode where no pool exists — `recordUsage` silently drops.
 *    The cost dashboard simply shows no data, which is correct.
 *
 * The recorder is a singleton (not per-plugin) because the capture points live
 * in three different packages (orchestrator streaming, extras, verifier) that
 * must all write to one place without threading a pool through every seam.
 */
import type { Pool } from 'pg';
import { computeCostUsd, type UsageTokens } from './pricing.js';

/** A single LLM call's usage, as handed to {@link recordUsage}. */
export interface UsageRecord extends UsageTokens {
  /** Logical origin: 'orchestrator', 'sub-agent', 'verifier', 'extras', … */
  readonly source: string;
  /** The model id the request was sent to (e.g. 'claude-opus-4-7'). */
  readonly model: string;
  /** Tenant scope, when known at the call site. */
  readonly tenantId?: string | undefined;
  /** Chat session id, when known. */
  readonly sessionId?: string | undefined;
  /** Turn id, when known. */
  readonly turnId?: string | undefined;
}

interface BufferedRow extends UsageRecord {
  readonly costUsd: number;
}

const FLUSH_INTERVAL_MS = 5_000;
const FLUSH_MAX_BATCH = 100;
/** Hard cap so a wedged DB can't grow the buffer without bound. */
const BUFFER_HARD_CAP = 10_000;

let pool: Pool | undefined;
const buffer: BufferedRow[] = [];
let flushTimer: ReturnType<typeof setInterval> | undefined;
let warnedDroppedNoPool = false;
let warnedFlushError = false;
let warnedBufferFull = false;

/**
 * Wires the recorder to a live pool. Idempotent: a second call with a pool is
 * ignored once one is set (the first plugin to activate wins). Safe to call
 * from multiple plugins.
 */
export function initUsageRecorder(p: Pool): void {
  if (pool) return;
  pool = p;
  if (!flushTimer) {
    flushTimer = setInterval(() => {
      void flush();
    }, FLUSH_INTERVAL_MS);
    // Don't keep the event loop alive solely for telemetry flushing.
    flushTimer.unref?.();
  }
}

/** True once a pool has been wired. */
export function isUsageRecorderReady(): boolean {
  return pool !== undefined;
}

/**
 * Buffers one usage row for async persistence. Computes USD cost eagerly so a
 * later price-table edit can't retroactively change historical rows. Returns
 * immediately; never awaits the DB.
 */
export function recordUsage(record: UsageRecord): void {
  if (!pool) {
    if (!warnedDroppedNoPool) {
      warnedDroppedNoPool = true;
      console.warn(
        '[usage-telemetry] recordUsage called before initUsageRecorder — dropping rows (in-memory KG mode?)',
      );
    }
    return;
  }
  if (buffer.length >= BUFFER_HARD_CAP) {
    if (!warnedBufferFull) {
      warnedBufferFull = true;
      console.warn('[usage-telemetry] buffer at hard cap — dropping rows until flush catches up');
    }
    return;
  }
  buffer.push({ ...record, costUsd: computeCostUsd(record.model, record) });
  if (buffer.length >= FLUSH_MAX_BATCH) void flush();
}

/**
 * Drains the buffer into Postgres in one multi-row INSERT. Best-effort: on
 * failure the in-flight rows are dropped (re-queueing risks unbounded growth
 * if the DB is down) and the error is logged once.
 */
export async function flush(): Promise<void> {
  if (!pool || buffer.length === 0) return;
  const rows = buffer.splice(0, FLUSH_MAX_BATCH);

  // Build a single parameterised multi-row INSERT: 9 columns per row.
  const cols = 9;
  const valuesSql = rows
    .map((_, i) => {
      const b = i * cols;
      return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9})`;
    })
    .join(',');
  const params: unknown[] = [];
  for (const r of rows) {
    params.push(
      r.source,
      r.model,
      r.inputTokens,
      r.outputTokens,
      r.cacheReadTokens,
      r.cacheCreationTokens,
      r.costUsd,
      r.tenantId ?? null,
      r.sessionId ?? null,
    );
  }

  try {
    await pool.query(
      `INSERT INTO token_usage
         (source, model, input_tokens, output_tokens,
          cache_read_tokens, cache_creation_tokens, cost_usd, tenant_id, session_id)
       VALUES ${valuesSql}`,
      params,
    );
    warnedFlushError = false;
  } catch (err) {
    if (!warnedFlushError) {
      warnedFlushError = true;
      console.warn(
        '[usage-telemetry] flush failed — dropping batch (has graph migration 0028 run?):',
        err instanceof Error ? err.message : err,
      );
    }
  }
}

/**
 * Test/shutdown helper: stop the flush timer and forget the pool. Flushes any
 * buffered rows first. The caller owns the pool's lifecycle.
 */
export async function shutdownUsageRecorder(): Promise<void> {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = undefined;
  }
  await flush();
  pool = undefined;
}
