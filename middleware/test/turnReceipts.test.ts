/**
 * #757 — persistent per-turn receipts: kernel store, retention reaper, and
 * operator read API. The orchestrator-side wiring (receipt reaches the store
 * on a real turn) lives in `test/orchestrator/turnReceiptPersistence.test.ts`;
 * here the units are exercised against a fake pg pool.
 */

import { strict as assert } from 'node:assert';
import { after, describe, it } from 'node:test';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import express from 'express';
import type { Pool } from 'pg';

import {
  PgTurnReceiptStore,
  resetTurnReceiptCounters,
  startTurnReceiptReaper,
  turnReceiptCounters,
} from '../src/receipts/store.js';
import { createReceiptRoutes } from '../src/receipts/routes.js';

interface RecordedQuery {
  sql: string;
  params: unknown[];
}

/** Minimal fake pg pool: records queries, answers from a script. */
function fakePool(
  handler: (sql: string, params: unknown[]) => { rows?: unknown[]; rowCount?: number } | Error,
): { pool: Pool; queries: RecordedQuery[] } {
  const queries: RecordedQuery[] = [];
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });
      const result = handler(sql, params);
      if (result instanceof Error) throw result;
      return { rows: result.rows ?? [], rowCount: result.rowCount ?? (result.rows?.length ?? 0) };
    },
  } as unknown as Pool;
  return { pool, queries };
}

const RECEIPT = {
  datasetsInterned: 2,
  fieldsMasked: 7,
  fieldsCleartext: 3,
  verbsExecuted: ['v4_sort'],
  pseudonymProjectionUsed: false,
};

describe('#757 PgTurnReceiptStore', () => {
  it('inserts one idempotent row per turn and counts the persist', async () => {
    resetTurnReceiptCounters();
    const { pool, queries } = fakePool(() => ({ rowCount: 1 }));
    const store = new PgTurnReceiptStore(pool);
    await store.record({
      turnId: 't-1',
      sessionScope: 'sess-1',
      channel: 'teams',
      model: 'claude-test',
      receipt: RECEIPT,
    });
    assert.equal(queries.length, 1);
    const q = queries[0]!;
    assert.match(q.sql, /INSERT INTO turn_receipts/);
    // Idempotence is the SQL's job: a replayed done event must hit the
    // turn_id conflict target, not add a second row.
    assert.match(q.sql, /ON CONFLICT \(turn_id\) DO NOTHING/);
    assert.deepEqual(q.params.slice(0, 4), ['t-1', 'sess-1', 'teams', 'claude-test']);
    assert.deepEqual(JSON.parse(q.params[4] as string), RECEIPT);
    assert.equal(turnReceiptCounters().persisted, 1);
    assert.equal(turnReceiptCounters().persistFailures, 0);
  });

  it('counts a storage failure and rethrows (caller decides turn fate)', async () => {
    resetTurnReceiptCounters();
    const { pool } = fakePool(() => new Error('pg down'));
    const store = new PgTurnReceiptStore(pool);
    await assert.rejects(
      store.record({ turnId: 't-2', receipt: RECEIPT }),
      /pg down/,
    );
    assert.equal(turnReceiptCounters().persistFailures, 1);
    assert.equal(turnReceiptCounters().persisted, 0);
  });

  it('stores absent metadata as NULL, not as the string "undefined"', async () => {
    resetTurnReceiptCounters();
    const { pool, queries } = fakePool(() => ({ rowCount: 1 }));
    await new PgTurnReceiptStore(pool).record({ turnId: 't-3', receipt: RECEIPT });
    assert.deepEqual(queries[0]!.params.slice(0, 4), ['t-3', null, null, null]);
  });

  it('a replayed turn (ON CONFLICT no-op) does not inflate the persisted counter', async () => {
    resetTurnReceiptCounters();
    const { pool } = fakePool(() => ({ rowCount: 0 }));
    await new PgTurnReceiptStore(pool).record({ turnId: 't-4', receipt: RECEIPT });
    assert.equal(turnReceiptCounters().persisted, 0);
    assert.equal(turnReceiptCounters().persistFailures, 0);
  });
});

describe('#757 retention reaper', () => {
  it('deletes past-retention rows eagerly at start, anchored on the DB clock', async () => {
    const { pool, queries } = fakePool(() => ({ rowCount: 2 }));
    const reaper = startTurnReceiptReaper(pool, { retentionDays: 30, intervalMs: 60_000 });
    try {
      // Eager boot tick: a process restarting more often than the interval
      // must still enforce retention — so the first pass fires immediately,
      // without waiting for the (long) interval.
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.ok(queries.length >= 1, 'reaper must have ticked at least once');
      const q = queries[0]!;
      assert.match(q.sql, /DELETE FROM turn_receipts/);
      // The cutoff must be computed from NOW() in the database — never a
      // process-clock timestamp parameter (#709: anchor ≠ what a lagging
      // process controls).
      assert.match(q.sql, /NOW\(\) - make_interval/);
      assert.deepEqual(q.params, [30]);
    } finally {
      reaper.stop();
    }
  });

  it('a failing tick logs but never throws out of the timer', async () => {
    const { pool, queries } = fakePool(() => new Error('relation missing'));
    const reaper = startTurnReceiptReaper(pool, { retentionDays: 30, intervalMs: 5 });
    try {
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.ok(queries.length >= 1);
      // Reaching this line without an unhandled rejection IS the assertion.
    } finally {
      reaper.stop();
    }
  });
});

describe('#757 operator receipts API', () => {
  const servers: Server[] = [];
  after(async () => {
    await Promise.all(
      servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
    );
  });

  const ROW_ID = '0f5c1c3a-1111-4222-8333-444455556666';
  const ROW = {
    id: ROW_ID,
    turn_id: 't-1',
    session_scope: 'sess-1',
    channel: 'teams',
    model: 'claude-test',
    receipt: RECEIPT,
    created_at: new Date('2026-08-20T10:00:00.123Z'),
    // pg's own text rendering — microsecond-exact, beyond JS Date precision.
    created_at_cursor: '2026-08-20 10:00:00.123456+00',
  };

  async function serve(
    handler: Parameters<typeof fakePool>[0],
  ): Promise<{ baseUrl: string; queries: RecordedQuery[] }> {
    const { pool, queries } = fakePool(handler);
    const app = express();
    app.use('/api/v1/operator/receipts', createReceiptRoutes(pool));
    const server: Server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    servers.push(server);
    const port = (server.address() as AddressInfo).port;
    return { baseUrl: `http://127.0.0.1:${String(port)}/api/v1/operator/receipts`, queries };
  }

  it('lists receipts newest-first with camelCase mapping and no cursor on a short page', async () => {
    const { baseUrl } = await serve(() => ({ rows: [ROW] }));
    const res = await fetch(`${baseUrl}?limit=25`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { items: Array<Record<string, unknown>>; nextCursor?: string };
    assert.equal(body.items.length, 1);
    assert.equal(body.items[0]!.turnId, 't-1');
    assert.equal(body.items[0]!.sessionScope, 'sess-1');
    assert.equal(body.items[0]!.createdAt, '2026-08-20T10:00:00.123Z');
    // The keyset internals never leak into the item shape.
    assert.equal('id' in body.items[0]!, false);
    assert.equal('created_at_cursor' in body.items[0]!, false);
    assert.deepEqual(body.items[0]!.receipt, RECEIPT);
    assert.equal(body.nextCursor, undefined);
  });

  it('emits a composite keyset nextCursor exactly when the page is full', async () => {
    const { baseUrl } = await serve(() => ({ rows: [ROW] }));
    const res = await fetch(`${baseUrl}?limit=1`);
    const body = (await res.json()) as { nextCursor?: string };
    // pg's microsecond-exact text stamp + row id — a bare ISO(ms) cursor
    // would lose exact-tie and truncation-gap rows at page boundaries.
    assert.equal(body.nextCursor, `2026-08-20 10:00:00.123456+00|${ROW_ID}`);
  });

  it('threads scope + composite cursor filters into the query parameters', async () => {
    const { baseUrl, queries } = await serve(() => ({ rows: [] }));
    const cursor = encodeURIComponent(`2026-08-20 10:00:00.123456+00|${ROW_ID}`);
    const res = await fetch(`${baseUrl}?scope=sess-1&cursor=${cursor}&limit=10`);
    assert.equal(res.status, 200);
    const q = queries[0]!;
    assert.ok(q.params.includes('sess-1'));
    assert.ok(q.params.includes('2026-08-20 10:00:00.123456+00'));
    assert.ok(q.params.includes(ROW_ID));
    assert.equal(q.params[q.params.length - 1], 10);
    assert.match(q.sql, /session_scope = \$1/);
    assert.match(q.sql, /\(created_at, id\) < \(\$2::timestamptz, \$3::uuid\)/);
    assert.match(q.sql, /ORDER BY created_at DESC, id DESC/);
  });

  it('rejects a malformed cursor with 400 before the pool is touched', async () => {
    const { baseUrl, queries } = await serve(() => ({ rows: [] }));
    for (const bad of ['not-a-cursor', '2026-08-20 10:00:00+00|not-a-uuid', `|${ROW_ID}`]) {
      const res = await fetch(`${baseUrl}?cursor=${encodeURIComponent(bad)}`);
      assert.equal(res.status, 400, `cursor ${JSON.stringify(bad)} must 400`);
    }
    assert.equal(queries.length, 0);
  });

  it('rejects an invalid limit with 400 instead of clamping silently', async () => {
    const { baseUrl, queries } = await serve(() => ({ rows: [] }));
    const res = await fetch(`${baseUrl}?limit=5000`);
    assert.equal(res.status, 400);
    assert.equal(queries.length, 0, 'invalid input must never reach the pool');
  });

  it('serves a single receipt by turn id and 404s an unknown one', async () => {
    const { baseUrl } = await serve((_sql, params) =>
      params[0] === 't-1' ? { rows: [ROW] } : { rows: [] },
    );
    const hit = await fetch(`${baseUrl}/t-1`);
    assert.equal(hit.status, 200);
    assert.equal(((await hit.json()) as { turnId: string }).turnId, 't-1');
    const miss = await fetch(`${baseUrl}/t-unknown`);
    assert.equal(miss.status, 404);
  });

  it('maps a pool failure to 500 without leaking the error', async () => {
    const { baseUrl } = await serve(() => new Error('secret dsn in message'));
    const res = await fetch(`${baseUrl}`);
    assert.equal(res.status, 500);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, 'receipts_query_failed');
    assert.ok(!JSON.stringify(body).includes('secret dsn'));
  });
});
