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

export class PgTurnReceiptStore implements TurnReceiptStore {
  constructor(private readonly pool: Pool) {}

  async record(entry: TurnReceiptRecordInput): Promise<void> {
    try {
      // Idempotent on turn_id: a replayed `done` event (retry, double flush)
      // must not duplicate the row; first write wins.
      const result = await this.pool.query(
        `INSERT INTO turn_receipts (turn_id, session_scope, channel, model, receipt)
         VALUES ($1, $2, $3, $4, $5::jsonb)
         ON CONFLICT (turn_id) DO NOTHING`,
        [
          entry.turnId,
          entry.sessionScope ?? null,
          entry.channel ?? null,
          entry.model ?? null,
          JSON.stringify(entry.receipt),
        ],
      );
      // A replayed turn hits DO NOTHING (rowCount 0) — that is not a
      // persist, and the counter must not overstate the record.
      if ((result.rowCount ?? 0) > 0) {
        counters.persisted += 1;
      }
    } catch (err) {
      counters.persistFailures += 1;
      throw err;
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
      const result = await pool.query(
        `DELETE FROM turn_receipts
          WHERE created_at < NOW() - make_interval(days => $1)`,
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
