/**
 * Process-level singleton that persists transcription-minute usage rows to
 * the shared Neon Postgres `transcription_usage` table (created by graph
 * migration 0031). Sibling of the token recorder in `./recorder.js` — same
 * design constraints, different unit (minutes, not tokens):
 *
 *  - **Never throw into the caller.** Metering is observational on the write
 *    path; a DB hiccup must not break a transcription. All writes are
 *    fire-and-forget with swallowed (once-logged) errors.
 *  - **Non-blocking hot path.** `recordTranscriptionUsage` buffers in memory
 *    and flushes on an interval / size threshold.
 *  - **No-op until wired.** Before `initTranscriptionUsageRecorder(pool)`
 *    runs — i.e. in in-memory-KG mode, where no `graphPool` service exists —
 *    rows are silently dropped (warned once). Consequence stated honestly:
 *    with no rows there is no monthly sum, so the per-agent quota is
 *    STRUCTURALLY UNENFORCED in in-memory-KG mode. The duration cap does not
 *    depend on this recorder and still holds there.
 *
 * Cost is computed at write time from the per-minute price table and frozen
 * into `cost_usd`, so later price-table edits can't rewrite history (same
 * invariant as `token_usage`).
 */
import type { Pool } from 'pg';

/**
 * Client-derived per-minute USD prices (#584 research: OpenAI reports no
 * per-call billing figure, so Billed Minutes — and therefore cost — are
 * estimates). Keyed by normalised model id; matching mirrors
 * `pricing.ts` (exact first, then substring, most-specific keyword first —
 * 'live-transcribe' must beat 'transcribe').
 */
const EXACT_MINUTE_PRICES: Readonly<Record<string, number>> = {
  'gpt-transcribe': 0.0045,
  'openai:gpt-transcribe': 0.0045,
  'gpt-live-transcribe': 0.017,
  'openai:gpt-live-transcribe': 0.017,
};

const FAMILY_MINUTE_PRICES: ReadonlyArray<readonly [string, number]> = [
  ['live-transcribe', 0.017],
  ['transcribe', 0.0045],
];

const warnedUnknownModels = new Set<string>();

/** USD per minute for a model; unknown models price at $0 and warn once. */
export function transcriptionPricePerMinuteUsd(model: string): number {
  const key = model.trim().toLowerCase();
  const exact = EXACT_MINUTE_PRICES[key];
  if (exact !== undefined) return exact;
  for (const [keyword, price] of FAMILY_MINUTE_PRICES) {
    if (key.includes(keyword)) return price;
  }
  if (!warnedUnknownModels.has(key)) {
    warnedUnknownModels.add(key);
    console.warn(
      `[usage-telemetry] no per-minute price for transcription model '${model}' — recording cost as $0`,
    );
  }
  return 0;
}

/** Rounded to 8 decimals, matching the NUMERIC(14,8) column. */
export function computeTranscriptionCostUsd(
  model: string,
  billedMinutes: number,
): number {
  const cost = transcriptionPricePerMinuteUsd(model) * Math.max(0, billedMinutes);
  return Math.round(cost * 1e8) / 1e8;
}

/** One provider call's metering, as handed to {@link recordTranscriptionUsage}. */
export interface TranscriptionUsageRecord {
  /** Probed duration of the source recording, counted once per recording. */
  readonly sourceMinutes: number;
  /** Client-derived estimate of provider-billed time (retries book in full). */
  readonly billedMinutes: number;
  /** The provider model id billed (e.g. 'gpt-transcribe'). */
  readonly model: string;
  /** Installed agent (plugin) id the quota is keyed on. */
  readonly agentId: string;
  /** Recording identity (sha256-derived, see transcriptArtifact). */
  readonly recordingId: string;
  /** Turn id, when the call runs inside a turn. */
  readonly turnId?: string | undefined;
}

interface BufferedRow extends TranscriptionUsageRecord {
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
 * Wires the recorder to a live pool. Idempotent: the first caller wins.
 */
export function initTranscriptionUsageRecorder(p: Pool): void {
  if (pool) return;
  pool = p;
  if (!flushTimer) {
    flushTimer = setInterval(() => {
      void flushTranscriptionUsage();
    }, FLUSH_INTERVAL_MS);
    // Don't keep the event loop alive solely for telemetry flushing.
    flushTimer.unref?.();
  }
}

/** True once a pool has been wired. */
export function isTranscriptionUsageRecorderReady(): boolean {
  return pool !== undefined;
}

/**
 * Buffers one usage row for async persistence. Computes USD cost eagerly so
 * a later price-table edit can't retroactively change historical rows.
 * Returns immediately; never awaits the DB, never throws.
 */
export function recordTranscriptionUsage(record: TranscriptionUsageRecord): void {
  if (!pool) {
    if (!warnedDroppedNoPool) {
      warnedDroppedNoPool = true;
      console.warn(
        '[usage-telemetry] recordTranscriptionUsage called before initTranscriptionUsageRecorder — dropping rows; the per-agent transcription quota is unenforced without them (in-memory KG mode?)',
      );
    }
    return;
  }
  if (buffer.length >= BUFFER_HARD_CAP) {
    if (!warnedBufferFull) {
      warnedBufferFull = true;
      console.warn(
        '[usage-telemetry] transcription buffer at hard cap — dropping rows until flush catches up',
      );
    }
    return;
  }
  buffer.push({
    ...record,
    costUsd: computeTranscriptionCostUsd(record.model, record.billedMinutes),
  });
  if (buffer.length >= FLUSH_MAX_BATCH) void flushTranscriptionUsage();
}

/**
 * Drains the buffer into Postgres in one multi-row INSERT. Best-effort: on
 * failure the in-flight rows are dropped (re-queueing risks unbounded growth
 * if the DB is down) and the error is logged once.
 */
export async function flushTranscriptionUsage(): Promise<void> {
  if (!pool || buffer.length === 0) return;
  const rows = buffer.splice(0, FLUSH_MAX_BATCH);

  // Single parameterised multi-row INSERT: 7 columns per row.
  const cols = 7;
  const valuesSql = rows
    .map((_, i) => {
      const b = i * cols;
      return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7})`;
    })
    .join(',');
  const params: unknown[] = [];
  for (const r of rows) {
    params.push(
      r.sourceMinutes,
      r.billedMinutes,
      r.model,
      r.costUsd,
      r.agentId,
      r.recordingId,
      r.turnId ?? null,
    );
  }

  try {
    await pool.query(
      `INSERT INTO transcription_usage
         (source_minutes, billed_minutes, model, cost_usd,
          agent_id, recording_id, turn_id)
       VALUES ${valuesSql}`,
      params,
    );
    warnedFlushError = false;
  } catch (err) {
    if (!warnedFlushError) {
      warnedFlushError = true;
      console.warn(
        '[usage-telemetry] transcription flush failed — dropping batch (has graph migration 0031 run?):',
        err instanceof Error ? err.message : err,
      );
    }
  }
}

/**
 * Test/shutdown helper: stop the flush timer and forget the pool. Flushes
 * any buffered rows first. The caller owns the pool's lifecycle.
 */
export async function shutdownTranscriptionUsageRecorder(): Promise<void> {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = undefined;
  }
  await flushTranscriptionUsage();
  pool = undefined;
}

/**
 * Calendar-month Billed-Minutes sum for one agent — the quota pre-check's
 * read side. Takes an explicit pool (read path stays request-scoped, same
 * split as `queries.ts`) and DOES throw on DB error: the quota caller owns
 * the fail-open decision and must see the failure to log its audit warning.
 *
 * The sum sees only FLUSHED rows — a quota caller must drain the recorder
 * first (`flushTranscriptionUsage()`), or calls landing inside one flush
 * window each read a stale sum and the level-trigger's "overshoot bounded by
 * one duration-cap length" degrades to N × cap.
 */
export async function sumTranscriptionBilledMinutesThisMonth(
  p: Pool,
  agentId: string,
): Promise<number> {
  const res = await p.query<{ total: string | number | null }>(
    `SELECT COALESCE(SUM(billed_minutes), 0) AS total
       FROM transcription_usage
      WHERE agent_id = $1
        AND created_at >= date_trunc('month', NOW())`,
    [agentId],
  );
  // pg returns NUMERIC aggregates as strings.
  const raw = res.rows[0]?.total;
  const n = typeof raw === 'string' ? Number(raw) : (raw ?? 0);
  return Number.isFinite(n) ? n : 0;
}
