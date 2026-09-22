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
  /**
   * #1098 — the provider id the call actually ran on (`anthropic`, `openai`, a
   * plugin provider id). Passed at the provider boundary so a fallback is
   * visible in the ledger; mirrors `turn_receipts.provider`. NULL when the
   * seam does not know it.
   */
  readonly provider?: string | undefined;
  /**
   * #1098 — when the LLM call happened, captured at `recordUsage()` time. The
   * recorder buffers and flushes on a 5s grid, so the DB `DEFAULT NOW()` would
   * record the flush tick, not the call; passing this explicitly keeps the
   * true call time. Defaults to the moment `recordUsage()` runs.
   */
  readonly occurredAt?: Date | undefined;
  /**
   * OM-103 — billed cost, when the CALLER knows it and the price table does
   * not. Set to `0` by the subscription (`claude-cli`) seams: the operator
   * pays a flat fee, so per-token pricing would invent money nobody spent.
   * Omitted (the ordinary case) means "derive it from the price table".
   */
  readonly costUsd?: number | undefined;
  /**
   * OM-103 — what this call would have cost on the metered API, as reported
   * by the vendor. Informational only: it lands in its own column and is
   * never summed into a billed total.
   */
  readonly referenceCostUsd?: number | undefined;
}

interface BufferedRow extends UsageRecord {
  readonly costUsd: number;
  readonly referenceCostUsd: number;
  readonly occurredAt: Date;
}

/**
 * #1098 — ambient turn attribution. The capture seams (streaming, extras,
 * verifier, routers) run inside the orchestrator's per-turn AsyncLocalStorage
 * scope, but this package sits below the orchestrator and cannot import it. So
 * the orchestrator registers a provider once (see `setUsageContextProvider`)
 * and the recorder reads `turnId`/`sessionId` from it at `recordUsage()` time.
 * Ids passed explicitly on a `UsageRecord` still win; off-turn callers (e.g.
 * background jobs) get `undefined` → NULL, never a throw.
 */
export interface UsageContext {
  readonly turnId?: string | undefined;
  readonly sessionId?: string | undefined;
}

let contextProvider: (() => UsageContext | undefined) | undefined;

/**
 * Registers the ambient turn-context reader. Idempotent-friendly: a later call
 * replaces the provider. Passing `undefined` clears it (used by tests).
 */
export function setUsageContextProvider(
  provider: (() => UsageContext | undefined) | undefined,
): void {
  contextProvider = provider;
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
  // #1098: fill turn attribution from the ambient turn context, but never
  // override ids the caller passed explicitly. The read is defensive — a
  // throwing provider must not break a telemetry write.
  let ctx: UsageContext | undefined;
  try {
    ctx = contextProvider?.();
  } catch {
    ctx = undefined;
  }
  // OM-103: an explicit `costUsd` from the caller wins over the price table.
  // `?? ` and not `||` — `0` is the whole point on the subscription path.
  buffer.push({
    ...record,
    turnId: record.turnId ?? ctx?.turnId,
    sessionId: record.sessionId ?? ctx?.sessionId,
    // #1098: freeze the call time now; the flush that writes this row may be
    // up to FLUSH_INTERVAL_MS later.
    occurredAt: record.occurredAt ?? new Date(),
    costUsd: record.costUsd ?? computeCostUsd(record.model, record),
    referenceCostUsd: record.referenceCostUsd ?? 0,
  });
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

  // Build a single parameterised multi-row INSERT: 13 columns per row
  // (OM-103 added `reference_cost_usd`, graph migration 0032; #1098 added
  // `turn_id`/`provider`/explicit `created_at`, graph migration 0033).
  const cols = 13;
  const valuesSql = rows
    .map((_, i) => {
      const b = i * cols;
      const placeholders = Array.from({ length: cols }, (_unused, c) => `$${b + c + 1}`);
      return `(${placeholders.join(',')})`;
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
      r.referenceCostUsd,
      r.turnId ?? null,
      r.provider ?? null,
      r.occurredAt,
    );
  }

  try {
    await pool.query(
      `INSERT INTO token_usage
         (source, model, input_tokens, output_tokens,
          cache_read_tokens, cache_creation_tokens, cost_usd, tenant_id, session_id,
          reference_cost_usd, turn_id, provider, created_at)
       VALUES ${valuesSql}`,
      params,
    );
    warnedFlushError = false;
  } catch (err) {
    if (!warnedFlushError) {
      warnedFlushError = true;
      console.warn(
        '[usage-telemetry] flush failed — dropping batch (have graph migrations 0028 + 0032 run?):',
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
