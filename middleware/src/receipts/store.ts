/**
 * #757 — Postgres-backed persistent per-turn receipt store.
 *
 * Backs the `turnReceiptStore` service the orchestrator resolves late-bound
 * at turn end (see `plugin-api/src/turnReceiptStore.ts` for the contract and
 * why this is deliberately NOT the RunTrace). Postgres-only, like the
 * Conductor: on the in-memory backend the service is simply never provided
 * and receipts stay ephemeral.
 *
 * Failure posture: `record()` throws to its caller; the orchestrator counts
 * and logs the failure but never fails the turn over it — the user's answer
 * outranks the audit row, and the loss is observable (`persistFailures`),
 * never silent. That is the exact inversion of the RunTrace defect (#684):
 * there the drop was invisible; here it is counted.
 */

import type { Pool } from 'pg';
import type {
  TurnReceiptRecordInput,
  TurnReceiptStore,
} from '@omadia/plugin-api';

import {
  HASH_VERSION,
  RECEIPT_STREAM_ID,
  computeEntryHash,
  genesisHash,
} from './chain.js';

/** Process-wide failure counters, exported for /health-style introspection
 *  and asserted in tests. Mirrors `runTraceObservability.ts`'s "count what
 *  would otherwise be silently incomplete" obligation. */
export interface TurnReceiptObservability {
  persisted: number;
  persistFailures: number;
}

const counters: TurnReceiptObservability = { persisted: 0, persistFailures: 0 };

export function turnReceiptCounters(): Readonly<TurnReceiptObservability> {
  return counters;
}

/** Test seam only. */
export function resetTurnReceiptCounters(): void {
  counters.persisted = 0;
  counters.persistFailures = 0;
}

/** #758 — the canonical hash payload of a receipt row. NEVER includes
 *  DB-generated values (created_at): time is anchored by checkpoint cadence,
 *  not per-row. Exported so the #761 verifier recomputes the identical shape.
 *
 *  The JSON round-trip is load-bearing (review M3): the verifier recomputes
 *  from the stored JSONB, which honored `toJSON` at write time — hashing the
 *  live object would canonicalize e.g. a Date to `{}` while the row stores
 *  its ISO string, a guaranteed spurious mismatch. Round-tripping here makes
 *  hash input and stored row see the identical plain-JSON value. */
export function receiptChainPayload(entry: TurnReceiptRecordInput): unknown {
  return JSON.parse(
    JSON.stringify({
      turnId: entry.turnId,
      sessionScope: entry.sessionScope ?? null,
      channel: entry.channel ?? null,
      model: entry.model ?? null,
      receipt: entry.receipt,
    }),
  );
}

export class PgTurnReceiptStore implements TurnReceiptStore {
  constructor(private readonly pool: Pool) {}

  async record(entry: TurnReceiptRecordInput): Promise<void> {
    const client = await this.pool.connect();
    try {
      // #758 — chained append. One transaction: lock the stream head
      // (FOR UPDATE serializes concurrent appends into a single linear
      // chain — no forks), compute seq/prev, insert, advance the head.
      // Idempotence on turn_id is preserved: a replayed `done` event hits
      // DO NOTHING, and then the head must NOT advance — the transaction
      // rolls back to keep head and rows consistent.
      await client.query('BEGIN');
      const headRes = await client.query<{ head_seq: string; head_hash: Buffer }>(
        `SELECT head_seq, head_hash FROM audit_stream_heads
          WHERE stream_id = $1 FOR UPDATE`,
        [RECEIPT_STREAM_ID],
      );
      const head = headRes.rows[0];
      const prevHash = head ? head.head_hash : genesisHash(RECEIPT_STREAM_ID);
      const seq = head ? Number(head.head_seq) + 1 : 1;
      const entryHash = computeEntryHash({
        streamId: RECEIPT_STREAM_ID,
        seq,
        prevHash,
        payload: receiptChainPayload(entry),
      });
      // #1033 W0 — `provider` / `fallback_used` are attribution columns
      // OUTSIDE the hashed payload (`receiptChainPayload` above): the chain
      // seals the privacy receipt, and widening the sealed shape would mark
      // every existing row `unsupported_hash_version`. See migration 0057.
      const inserted = await client.query(
        `INSERT INTO turn_receipts
           (turn_id, session_scope, channel, model, receipt,
            stream_id, seq, prev_hash, entry_hash, hash_version,
            provider, fallback_used)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT (turn_id) DO NOTHING`,
        [
          entry.turnId,
          entry.sessionScope ?? null,
          entry.channel ?? null,
          entry.model ?? null,
          JSON.stringify(entry.receipt),
          RECEIPT_STREAM_ID,
          seq,
          prevHash,
          entryHash,
          HASH_VERSION,
          entry.provider ?? null,
          entry.fallbackUsed === true,
        ],
      );
      if ((inserted.rowCount ?? 0) === 0) {
        // Replayed turn: no row, no head movement, no counter.
        await client.query('ROLLBACK');
        return;
      }
      await client.query(
        `INSERT INTO audit_stream_heads (stream_id, head_seq, head_hash, updated_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (stream_id)
         DO UPDATE SET head_seq = EXCLUDED.head_seq, head_hash = EXCLUDED.head_hash, updated_at = NOW()`,
        [RECEIPT_STREAM_ID, seq, entryHash],
      );
      await client.query('COMMIT');
      counters.persisted += 1;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* connection-level failure — nothing further to roll back */
      }
      counters.persistFailures += 1;
      throw err;
    } finally {
      client.release();
    }
  }
}

/**
 * Retention reaper: deletes receipt rows older than `retentionDays`. Runs on
 * an unref'd interval so it never keeps the process alive; each tick is
 * best-effort and logged on failure. The `created_at` anchor is the DB's own
 * clock (`NOW()`), never the process clock — the reaper-clock-race lesson
 * from #709: the anchor must not be a value the test (or a lagging process)
 * also controls.
 */
export function startTurnReceiptReaper(
  pool: Pool,
  opts: { retentionDays: number; intervalMs?: number },
): { stop: () => void } {
  const intervalMs = opts.intervalMs ?? 6 * 60 * 60 * 1000; // 6h
  const tick = async (): Promise<void> => {
    try {
      // #761 review H2 — chained rows are reaped only up to the greatest
      // CHECKPOINTED seq, so the surviving suffix always has a signed anchor
      // and a healthy install never turns "unanchored" just by aging past
      // retention. Pre-chain rows (seq IS NULL) reap freely; with no
      // checkpoints at all (no signing key) the COALESCE degrades to the
      // plain age rule — an operator without a key has no anchor to protect.
      const result = await pool.query(
        `DELETE FROM turn_receipts
          WHERE created_at < NOW() - make_interval(days => $1)
            AND (seq IS NULL
                 OR seq <= COALESCE(
                      (SELECT MAX(seq) FROM audit_checkpoints WHERE stream_id = 'receipts'),
                      seq))`,
        [opts.retentionDays],
      );
      if ((result.rowCount ?? 0) > 0) {
        console.log(
          `[receipts] reaper removed ${result.rowCount} receipt(s) past ${opts.retentionDays}d retention`,
        );
      }
    } catch (err) {
      console.error('[receipts] retention reaper tick failed:', err);
    }
  };
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();
  // Eager first pass: plugin activation (which applies the numbered
  // migrations, incl. `0039_turn_receipts`) runs well before this wiring in
  // `index.ts`, so the table exists here — and without the boot tick a
  // process restarting more often than the interval would never enforce
  // retention at all.
  void tick();
  return { stop: () => clearInterval(timer) };
}
