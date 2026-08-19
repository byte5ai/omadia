/**
 * #584 — transcription-minute usage recorder (metering).
 *
 * Pins the recorder's contract: cost is computed AT WRITE TIME from the
 * per-minute price table (a later price edit can't rewrite history), rows are
 * appended via a plain INSERT (append-only), one row per provider call, the
 * no-pool mode drops silently (in-memory-KG: quota structurally unenforced),
 * and the monthly-sum read side coerces pg's NUMERIC-as-string.
 *
 * Imported from SOURCE, not the built barrel, so a mutation in `src/` cannot
 * report green over stale `dist/`.
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';

import {
  transcriptionPricePerMinuteUsd,
  computeTranscriptionCostUsd,
  initTranscriptionUsageRecorder,
  isTranscriptionUsageRecorderReady,
  recordTranscriptionUsage,
  flushTranscriptionUsage,
  shutdownTranscriptionUsageRecorder,
  sumTranscriptionBilledMinutesThisMonth,
} from '../packages/harness-usage-telemetry/src/transcriptionUsage.js';

interface CapturedQuery {
  sql: string;
  params: unknown[];
}

function fakePool(
  onQuery?: (sql: string, params: unknown[]) => { rows: unknown[] },
): { pool: Pool; queries: CapturedQuery[] } {
  const queries: CapturedQuery[] = [];
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });
      return onQuery ? onQuery(sql, params) : { rows: [] };
    },
  } as unknown as Pool;
  return { pool, queries };
}

afterEach(async () => {
  // The recorder is a module-level singleton — reset between tests.
  await shutdownTranscriptionUsageRecorder();
});

describe('#584 — per-minute price table', () => {
  it('prices batch and realtime models per the #584 research', () => {
    assert.equal(transcriptionPricePerMinuteUsd('gpt-transcribe'), 0.0045);
    assert.equal(transcriptionPricePerMinuteUsd('openai:gpt-transcribe'), 0.0045);
    assert.equal(transcriptionPricePerMinuteUsd('gpt-live-transcribe'), 0.017);
    assert.equal(
      transcriptionPricePerMinuteUsd('openai:gpt-live-transcribe'),
      0.017,
    );
  });

  it('matches most-specific family keyword first (live beats batch)', () => {
    // A future versioned id must not fall back to the cheaper batch rate.
    assert.equal(
      transcriptionPricePerMinuteUsd('vendor:gpt-live-transcribe-2'),
      0.017,
    );
  });

  it('prices unknown models at $0 instead of throwing', () => {
    assert.equal(transcriptionPricePerMinuteUsd('mystery-model'), 0);
    assert.equal(computeTranscriptionCostUsd('mystery-model', 100), 0);
  });

  it('rounds cost to 8 decimals and clamps negative minutes', () => {
    assert.equal(computeTranscriptionCostUsd('gpt-transcribe', 10), 0.045);
    assert.equal(computeTranscriptionCostUsd('gpt-transcribe', -5), 0);
  });
});

describe('#584 — the recorder writes cost-at-write, append-only', () => {
  it('drops rows silently before init (in-memory-KG mode) and never throws', async () => {
    assert.equal(isTranscriptionUsageRecorderReady(), false);
    recordTranscriptionUsage({
      sourceMinutes: 1,
      billedMinutes: 1,
      model: 'gpt-transcribe',
      agentId: 'agent-a',
      recordingId: 'rec-1',
    });
    await flushTranscriptionUsage(); // no pool — must be a no-op
  });

  it('flushes one INSERT row per recorded provider call with frozen cost', async () => {
    const { pool, queries } = fakePool();
    initTranscriptionUsageRecorder(pool);
    assert.equal(isTranscriptionUsageRecorderReady(), true);

    recordTranscriptionUsage({
      sourceMinutes: 10,
      billedMinutes: 20, // 10 source minutes × 2 attempts — retry books in full
      model: 'gpt-transcribe',
      agentId: 'agent-a',
      recordingId: 'rec-1',
      turnId: 'turn-1',
    });
    recordTranscriptionUsage({
      sourceMinutes: 3,
      billedMinutes: 3,
      model: 'gpt-transcribe',
      agentId: 'agent-b',
      recordingId: 'rec-2',
    });
    await flushTranscriptionUsage();

    assert.equal(queries.length, 1);
    const q = queries[0]!;
    assert.match(q.sql, /INSERT INTO transcription_usage/);
    // Append-only contract: a plain INSERT, no upsert/update clause.
    assert.doesNotMatch(q.sql, /ON CONFLICT|UPDATE/i);
    // 7 columns × 2 rows; cost frozen at write time: 20 min × $0.0045.
    assert.equal(q.params.length, 14);
    assert.deepEqual(q.params.slice(0, 7), [
      10,
      20,
      'gpt-transcribe',
      0.09,
      'agent-a',
      'rec-1',
      'turn-1',
    ]);
    // Absent turnId lands as NULL, not undefined.
    assert.equal(q.params[13], null);
  });

  it('drops the batch on flush failure instead of throwing into the caller', async () => {
    const { pool } = fakePool(() => {
      throw new Error('db down');
    });
    initTranscriptionUsageRecorder(pool);
    recordTranscriptionUsage({
      sourceMinutes: 1,
      billedMinutes: 1,
      model: 'gpt-transcribe',
      agentId: 'agent-a',
      recordingId: 'rec-1',
    });
    await flushTranscriptionUsage(); // must not reject
  });
});

describe('#584 — monthly Billed-Minutes sum (quota read side)', () => {
  it('sums per agent over the calendar month and coerces NUMERIC strings', async () => {
    const { pool, queries } = fakePool(() => ({ rows: [{ total: '12.5' }] }));
    const total = await sumTranscriptionBilledMinutesThisMonth(pool, 'agent-a');
    assert.equal(total, 12.5);
    const q = queries[0]!;
    assert.match(q.sql, /SUM\(billed_minutes\)/);
    assert.match(q.sql, /date_trunc\('month', NOW\(\)\)/);
    assert.deepEqual(q.params, ['agent-a']);
  });

  it('propagates DB errors to the caller (who owns the fail-open decision)', async () => {
    const { pool } = fakePool(() => {
      throw new Error('db down');
    });
    await assert.rejects(
      sumTranscriptionBilledMinutesThisMonth(pool, 'agent-a'),
      /db down/,
    );
  });
});
