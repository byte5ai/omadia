/**
 * #760 — miss-report review queue routes, against a fake pg pool (same
 * pattern as the other operator-route suites: express on 127.0.0.1 + fetch).
 */

import { strict as assert } from 'node:assert';
import { after, describe, it } from 'node:test';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import express from 'express';
import type { Pool } from 'pg';

import { createMissReportRoutes } from '../src/privacy/missReportRoutes.js';

interface RecordedQuery {
  sql: string;
  params: unknown[];
}

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

const ROW = {
  id: '0f5c1c3a-1111-4222-8333-444455556666',
  reporter: 'op-1',
  term: 'Projekt Nachtfalke',
  description: null,
  turn_id: null,
  status: 'open' as const,
  resolved_by: null,
  resolved_at: null,
  created_at: new Date('2026-08-20T10:00:00.000Z'),
};

describe('#760 miss-report routes', () => {
  const servers: Server[] = [];
  after(async () => {
    await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
  });

  async function serve(
    handler: Parameters<typeof fakePool>[0],
  ): Promise<{ baseUrl: string; queries: RecordedQuery[] }> {
    const { pool, queries } = fakePool(handler);
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as express.Request & { session?: unknown }).session = { sub: 'op-1' } as never;
      next();
    });
    app.use('/api/v1/operator/privacy/miss-reports', createMissReportRoutes(pool));
    const server: Server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    servers.push(server);
    const port = (server.address() as AddressInfo).port;
    return { baseUrl: `http://127.0.0.1:${String(port)}/api/v1/operator/privacy/miss-reports`, queries };
  }

  it('files a report with the session actor and camelCase response shape', async () => {
    const { baseUrl, queries } = await serve(() => ({ rows: [ROW] }));
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ term: 'Projekt Nachtfalke' }),
    });
    assert.equal(res.status, 201);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.term, 'Projekt Nachtfalke');
    assert.equal(body.status, 'open');
    assert.equal(body.createdAt, '2026-08-20T10:00:00.000Z');
    assert.equal(queries[0]!.params[0], 'op-1', 'reporter comes from the session, never the body');
  });

  it('rejects an empty or oversized term with 400 before touching the pool', async () => {
    const { baseUrl, queries } = await serve(() => ({ rows: [ROW] }));
    for (const term of ['', 'x'.repeat(201)]) {
      const res = await fetch(baseUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ term }),
      });
      assert.equal(res.status, 400);
    }
    assert.equal(queries.length, 0);
  });

  it('lists open reports by default and threads the status filter', async () => {
    const { baseUrl, queries } = await serve(() => ({ rows: [ROW] }));
    const res = await fetch(baseUrl);
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { items: unknown[] }).items.length, 1);
    assert.ok(queries[0]!.params.includes('open'));
    await fetch(`${baseUrl}?status=all`);
    assert.ok(!queries[1]!.sql.includes('WHERE status'));
  });

  it('resolves an open report once and answers 409 on a second attempt', async () => {
    let resolved = false;
    const { baseUrl } = await serve((sql) => {
      if (!sql.includes('UPDATE')) return { rows: [ROW] };
      if (resolved) return { rows: [] };
      resolved = true;
      return { rows: [{ ...ROW, status: 'resolved', resolved_by: 'op-1', resolved_at: new Date() }] };
    });
    const first = await fetch(`${baseUrl}/${ROW.id}/resolve`, { method: 'POST' });
    assert.equal(first.status, 200);
    assert.equal(((await first.json()) as { status: string }).status, 'resolved');
    const second = await fetch(`${baseUrl}/${ROW.id}/resolve`, { method: 'POST' });
    assert.equal(second.status, 409);
  });

  it('rejects a malformed id with 400 before touching the pool', async () => {
    const { baseUrl, queries } = await serve(() => ({ rows: [] }));
    const res = await fetch(`${baseUrl}/not-a-uuid/resolve`, { method: 'POST' });
    assert.equal(res.status, 400);
    assert.equal(queries.length, 0);
  });
});
