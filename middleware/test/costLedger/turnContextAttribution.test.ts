import { strict as assert } from 'node:assert';
import { afterEach, describe, it } from 'node:test';

import {
  flushUsageRecorder,
  initUsageRecorder,
  recordUsage,
  setUsageContextProvider,
} from '@omadia/usage-telemetry';
import type { Pool } from 'pg';

import { turnContext } from '../../packages/harness-orchestrator/src/turnContext.js';

/**
 * #1098 — end-to-end wiring test for the attribution seam. The unit test in
 * `tokenUsageAttribution.test.ts` drives the recorder with a hand-registered
 * provider; this one installs the SAME provider the orchestrator registers in
 * `plugin.ts` (reads the ambient `turnContext`) and proves a `recordUsage` call
 * made *inside* a real `turnContext.run(...)` scope lands the turn's id/session
 * on the row — and that a call outside any turn writes NULL.
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

const COL = { sessionId: 8, turnId: 10 } as const;

const captured: CapturedQuery[] = [];
initUsageRecorder(fakePool(captured));

// The exact provider registered by the orchestrator (plugin.ts).
setUsageContextProvider(() => {
  const ctx = turnContext.current();
  if (!ctx) return undefined;
  return { turnId: ctx.turnId, sessionId: ctx.sessionScope };
});

function metered(): void {
  recordUsage({
    source: 'orchestrator',
    model: 'claude-sonnet-5',
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  });
}

describe('#1098 — recordUsage picks up the real ambient turn context', () => {
  afterEach(() => {
    captured.length = 0;
  });

  it('stamps the turn id and session scope from turnContext.run', async () => {
    await turnContext.run(
      { turnId: 'turn-real', turnDate: '2026-09-21', sessionScope: 'sess-real' },
      async () => {
        metered();
      },
    );
    await flushUsageRecorder();

    const row = captured[0];
    assert.ok(row);
    assert.equal(row.params[COL.turnId], 'turn-real');
    assert.equal(row.params[COL.sessionId], 'sess-real');
  });

  it('writes NULL ids for a call made outside any turn', async () => {
    metered();
    await flushUsageRecorder();

    const row = captured[0];
    assert.ok(row);
    assert.equal(row.params[COL.turnId], null);
    assert.equal(row.params[COL.sessionId], null);
  });
});
