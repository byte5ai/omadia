import { strict as assert } from 'node:assert';
import { afterEach, describe, it } from 'node:test';

import {
  flushUsageRecorder,
  initUsageRecorder,
  recordUsage,
  setUsageContextProvider,
} from '@omadia/usage-telemetry';
import type { Pool } from 'pg';

/**
 * #1098 — a cost-ledger row could not be attributed to a turn, a session, or a
 * real point in time: no write site passed ids, there was no `turn_id` column,
 * and `created_at` recorded the 5s flush tick (DEFAULT NOW() at flush) rather
 * than the call. These tests pin the fix at the recorder seam:
 *   - turn attribution is read from the ambient turn context the orchestrator
 *     registers via `setUsageContextProvider`;
 *   - the call time (`occurredAt`) is frozen at `recordUsage()` and written to
 *     `created_at`, so it survives the buffered flush;
 *   - a call site with no turn context still writes NULL ids, never throws.
 */

interface CapturedQuery {
  readonly sql: string;
  readonly params: readonly unknown[];
}

function fakePool(captured: CapturedQuery[]): Pool {
  return {
    query: (sql: string, params: readonly unknown[]) => {
      captured.push({ sql, params });
      return Promise.resolve({ rows: [] });
    },
  } as unknown as Pool;
}

/** Column order of the INSERT in `recorder.ts` (10 from 0028/0032, +3 from #1098). */
const COL = {
  source: 0,
  model: 1,
  inputTokens: 2,
  outputTokens: 3,
  cacheReadTokens: 4,
  cacheCreationTokens: 5,
  costUsd: 6,
  tenantId: 7,
  sessionId: 8,
  referenceCostUsd: 9,
  turnId: 10,
  provider: 11,
  createdAt: 12,
} as const;

// One pool for the file: `initUsageRecorder` is idempotent (first pool wins),
// so cases clear the buffer/capture between them rather than re-initialising.
const captured: CapturedQuery[] = [];
initUsageRecorder(fakePool(captured));

function metered(source: string): void {
  recordUsage({
    source,
    model: 'claude-sonnet-5',
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  });
}

describe('#1098 — cost-ledger rows carry turn attribution and call time', () => {
  afterEach(() => {
    setUsageContextProvider(undefined);
    captured.length = 0;
  });

  it('writes a turn with session_id and turn_id from the ambient context', async () => {
    setUsageContextProvider(() => ({ turnId: 'turn-1', sessionId: 'sess-1' }));

    metered('orchestrator');
    await flushUsageRecorder();

    const row = captured[0];
    assert.ok(row);
    assert.match(row.sql, /turn_id/);
    assert.match(row.sql, /created_at/);
    assert.equal(row.params[COL.turnId], 'turn-1');
    assert.equal(row.params[COL.sessionId], 'sess-1');
  });

  it('keeps two turns in the same flush window separable via turn_id', async () => {
    // Both rows land in ONE flush — the exact case where created_at collides
    // and only turn_id can tell them apart.
    setUsageContextProvider(() => ({ turnId: 'turn-A', sessionId: 'sess-A' }));
    metered('orchestrator');
    setUsageContextProvider(() => ({ turnId: 'turn-B', sessionId: 'sess-B' }));
    metered('extras');

    await flushUsageRecorder();

    // Single multi-row INSERT: one query, two rows' worth of params.
    assert.equal(captured.length, 1);
    const row = captured[0];
    assert.ok(row);
    const cols = 13;
    assert.equal(row.params[COL.turnId], 'turn-A');
    assert.equal(row.params[cols + COL.turnId], 'turn-B');
    assert.notEqual(row.params[COL.turnId], row.params[cols + COL.turnId]);
  });

  it("writes the call's occurredAt to created_at, not the flush tick", async () => {
    // A call time well before the flush; if the row leaned on DEFAULT NOW() the
    // recorder would have to drop this, and the column would carry flush time.
    const callTime = new Date('2026-01-02T03:04:05.678Z');
    recordUsage({
      source: 'orchestrator',
      model: 'claude-sonnet-5',
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      occurredAt: callTime,
    });

    await flushUsageRecorder();

    const row = captured[0];
    assert.ok(row);
    assert.equal(row.params[COL.createdAt], callTime);
  });

  it('writes NULL ids (and does not throw) with no turn context', async () => {
    setUsageContextProvider(undefined);

    assert.doesNotThrow(() => metered('background-job'));
    await flushUsageRecorder();

    const row = captured[0];
    assert.ok(row);
    assert.equal(row.params[COL.turnId], null);
    assert.equal(row.params[COL.sessionId], null);
    assert.equal(row.params[COL.tenantId], null);
  });
});
