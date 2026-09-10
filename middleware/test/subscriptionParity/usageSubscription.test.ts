import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  CLI_CHAT_USAGE_SOURCE,
  CLI_COMPLETION_USAGE_SOURCE,
  SUBSCRIPTION_SOURCES,
  flushUsageRecorder,
  initUsageRecorder,
  recordUsage,
} from '@omadia/usage-telemetry';
import type { Pool } from 'pg';

/**
 * OM-103 — ADMIN → Nutzung & Kosten read "0 Calls" after a dozen subscription
 * turns, because every capture point sat on the metered API path. The ledger
 * now takes subscription rows, and they carry a shape of their own: tokens,
 * `cost_usd = 0` (a flat fee is not a per-call price) and the vendor's own
 * figure parked in `reference_cost_usd` where no total will sum it.
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

/** Column order of the INSERT in `recorder.ts`. */
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
} as const;

// `initUsageRecorder` is idempotent by design (the first pool wins, so several
// plugins can call it), so the whole file shares one pool and clears the buffer
// between cases instead of re-initialising.
const captured: CapturedQuery[] = [];
initUsageRecorder(fakePool(captured));

describe('OM-103 — subscription turns reach the cost ledger', () => {
  it('writes a CLI turn with zero billed cost and the vendor figure beside it', async () => {
    captured.length = 0;

    recordUsage({
      source: CLI_CHAT_USAGE_SOURCE,
      model: 'opus',
      inputTokens: 1200,
      outputTokens: 340,
      cacheReadTokens: 800,
      cacheCreationTokens: 64,
      costUsd: 0,
      referenceCostUsd: 0.0421,
    });
    await flushUsageRecorder();

    assert.equal(captured.length, 1);
    const row = captured[0];
    assert.ok(row);
    assert.match(row.sql, /INSERT INTO token_usage/);
    assert.match(row.sql, /reference_cost_usd/);
    assert.equal(row.params[COL.source], CLI_CHAT_USAGE_SOURCE);
    assert.equal(row.params[COL.model], 'opus');
    assert.equal(row.params[COL.inputTokens], 1200);
    assert.equal(row.params[COL.cacheCreationTokens], 64);
    // The point of the whole change: a subscription turn is a call, not money.
    assert.equal(row.params[COL.costUsd], 0);
    assert.equal(row.params[COL.referenceCostUsd], 0.0421);
  });

  it('defaults the reference cost to 0 for ordinary metered rows', async () => {
    captured.length = 0;

    recordUsage({
      source: 'orchestrator',
      model: 'claude-sonnet-5',
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
    await flushUsageRecorder();

    const row = captured[0];
    assert.ok(row);
    assert.equal(row.params[COL.referenceCostUsd], 0);
    // No explicit cost ⇒ still derived from the price table, unchanged.
    assert.ok(Number(row.params[COL.costUsd]) > 0);
  });

  it('lists both subscription seams among the sources the dashboard counts', () => {
    // The dashboard counts an exhaustive list, not a prefix, so a producer
    // that drifts out of that list would silently stop being counted.
    assert.ok(SUBSCRIPTION_SOURCES.includes(CLI_CHAT_USAGE_SOURCE));
    assert.ok(SUBSCRIPTION_SOURCES.includes(CLI_COMPLETION_USAGE_SOURCE));
    assert.notEqual(CLI_CHAT_USAGE_SOURCE, CLI_COMPLETION_USAGE_SOURCE);
  });
});
