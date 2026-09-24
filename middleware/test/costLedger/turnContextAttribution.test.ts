import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import {
  flushUsageRecorder,
  initUsageRecorder,
  recordUsage,
  setUsageContextProvider,
} from '@omadia/usage-telemetry';
import type { Pool } from 'pg';

import {
  currentUsageContext,
  turnContext,
  usageContextFromTurn,
} from '../../packages/harness-orchestrator/src/turnContext.js';

/**
 * #1098 — end-to-end wiring test for the attribution seam. The unit test in
 * `tokenUsageAttribution.test.ts` drives the recorder with a hand-registered
 * provider; this one installs `currentUsageContext` — the very function
 * `plugin.ts` registers — and proves a `recordUsage` call made inside the
 * orchestrator's own turn scope lands the turn's id/session on the row.
 *
 * Just as important is what must NOT be attributed: the outer scopes routes and
 * adapters open around a turn carry a placeholder `turnId` (`http-chat-<scope>`,
 * shared by every turn of a session and, for `http-default`, by every user; or
 * `''` on channel/routine/canvas turns). A row read off one of those looks
 * plausible and is wrong, so it must stay NULL.
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

const MIDDLEWARE_ROOT = path.resolve(import.meta.dirname, '../..');

const captured: CapturedQuery[] = [];
initUsageRecorder(fakePool(captured));

// The exact provider registered by the orchestrator (pinned below).
setUsageContextProvider(currentUsageContext);

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

async function onlyRow(): Promise<CapturedQuery> {
  await flushUsageRecorder();
  assert.equal(captured.length, 1);
  const row = captured[0];
  assert.ok(row);
  return row;
}

describe('#1098 — usageContextFromTurn only vouches for a real turn scope', () => {
  it('attributes the orchestrator scope (turn id + sessionScope)', () => {
    assert.deepEqual(
      usageContextFromTurn({ turnId: 't-1', turnDate: '2026-09-24', sessionScope: 's-1' }),
      { turnId: 't-1', sessionId: 's-1' },
    );
  });

  it("reads chat.ts's http-chat placeholder as no turn", () => {
    assert.equal(
      usageContextFromTurn({ turnId: 'http-chat-http-default', turnDate: '2026-09-24' }),
      undefined,
    );
  });

  it("reads an empty placeholder turn id as no turn, even with a session", () => {
    assert.equal(usageContextFromTurn({ turnId: '', turnDate: '2026-09-24' }), undefined);
    assert.equal(
      usageContextFromTurn({ turnId: '', turnDate: '2026-09-24', sessionScope: 's-1' }),
      undefined,
    );
  });

  it('reads no scope as no turn', () => {
    assert.equal(usageContextFromTurn(undefined), undefined);
  });

  it('is the provider plugin.ts registers with the recorder', () => {
    const source = readFileSync(
      path.join(MIDDLEWARE_ROOT, 'packages/harness-orchestrator/src/plugin.ts'),
      'utf8',
    );
    // A copy of the lambda in a test proves nothing about the wiring; this
    // pins that the orchestrator registers the shared helper tested here.
    assert.match(source, /setUsageContextProvider\(\s*currentUsageContext\s*\)/);
  });
});

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

    const row = await onlyRow();
    assert.equal(row.params[COL.turnId], 'turn-real');
    assert.equal(row.params[COL.sessionId], 'sess-real');
  });

  it("writes NULL ids inside chat.ts's placeholder scope (verifier / claude-cli path)", async () => {
    // What the verifier and the subscription runtime see: the route's outer
    // scope, with the orchestrator's inner scope already closed (or never open).
    await turnContext.run(
      { turnId: 'http-chat-http-default', turnDate: '2026-09-21' },
      async () => {
        metered();
      },
    );

    const row = await onlyRow();
    assert.equal(row.params[COL.turnId], null);
    assert.equal(row.params[COL.sessionId], null);
  });

  it('writes NULL ids inside a channel adapter scope (runWithChatParticipants)', async () => {
    await turnContext.runWithChatParticipants(
      { list: () => Promise.resolve([]) } as never,
      async () => {
        metered();
      },
    );

    const row = await onlyRow();
    assert.equal(row.params[COL.turnId], null);
    assert.equal(row.params[COL.sessionId], null);
  });

  it("the orchestrator's inner scope wins over the placeholder around it", async () => {
    await turnContext.run({ turnId: 'http-chat-s', turnDate: '2026-09-21' }, () =>
      turnContext.run(
        { turnId: 'turn-inner', turnDate: '2026-09-21', sessionScope: 's' },
        async () => {
          metered();
        },
      ),
    );

    const row = await onlyRow();
    assert.equal(row.params[COL.turnId], 'turn-inner');
    assert.equal(row.params[COL.sessionId], 's');
  });

  it('writes NULL ids for a call made outside any turn', async () => {
    metered();

    const row = await onlyRow();
    assert.equal(row.params[COL.turnId], null);
    assert.equal(row.params[COL.sessionId], null);
  });
});
