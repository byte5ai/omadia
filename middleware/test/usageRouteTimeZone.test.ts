import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { isIanaTimeZone } from '../src/routes/usage.js';

/**
 * #1396 — `GET /api/usage/dashboard?tz=` accepts IANA zone names only. A bare
 * offset is refused: Postgres reads `+02:00` with POSIX sign semantics, so it
 * would shift the buckets the wrong way rather than fail.
 */
describe('#1396 — usage route time-zone gate', () => {
  it('accepts IANA names', () => {
    for (const tz of ['UTC', 'Europe/Berlin', 'America/Argentina/Buenos_Aires', 'Etc/GMT+5']) {
      assert.equal(isIanaTimeZone(tz), true, tz);
    }
  });

  it('refuses offsets, unknown names and junk', () => {
    for (const tz of ['+02:00', '-05', 'Mars/Olympus_Mons', '', "Europe/Berlin'; --", 'a'.repeat(80)]) {
      assert.equal(isIanaTimeZone(tz), false, tz);
    }
  });
});

describe('#1396 — usage route request handling', () => {
  async function call(
    pool: { query: (sql: string, params: unknown[]) => Promise<{ rows: unknown[] }> },
    qs: string,
  ): Promise<{ status: number; body: unknown }> {
    const { default: express } = await import('express');
    const { createUsageRouter } = await import('../src/routes/usage.js');
    const app = express();
    app.use((req, _res, next) => {
      (req as unknown as { session: unknown }).session = { omadia_user_id: 'u1' };
      next();
    });
    app.use('/api/usage', createUsageRouter({ pool: pool as never }));
    const server = app.listen(0);
    try {
      const { port } = server.address() as { port: number };
      const res = await fetch(`http://127.0.0.1:${port}/api/usage/dashboard?${qs}`);
      return { status: res.status, body: await res.json() };
    } finally {
      server.close();
    }
  }

  it('falls back to UTC when Postgres does not know a zone Intl accepts', async () => {
    const zones: unknown[] = [];
    const pool = {
      query: async (_sql: string, params: unknown[]) => {
        const tz = params.find((p) => typeof p === 'string' && /\//.test(p) || p === 'UTC');
        zones.push(tz);
        if (tz === 'America/Nuuk') throw Object.assign(new Error('time zone not recognized'), { code: '22023' });
        return { rows: [] };
      },
    };
    const { status } = await call(pool, 'bucket=day&since=2026-01-01T00:00:00Z&tz=America/Nuuk');
    assert.equal(status, 200);
    assert.ok(zones.includes('UTC'), 'retried in UTC');
  });

  it('refuses an all-time hourly series', async () => {
    const pool = { query: async () => ({ rows: [] }) };
    assert.equal((await call(pool, 'bucket=hour')).status, 400);
    assert.equal((await call(pool, 'bucket=day')).status, 200);
  });
});
