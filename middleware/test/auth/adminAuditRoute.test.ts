import { strict as assert } from 'node:assert';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';

import express from 'express';
import type { Pool } from 'pg';

import {
  AdminAuditLog,
  auditActorFromLabel,
  auditActorFromRequest,
  type AuditEntry,
  type AuditListOptions,
} from '../../src/auth/adminAuditLog.js';
import { createAdminAuditRouter } from '../../src/routes/adminAudit.js';
import { listenLoopback } from '../_helpers/listenLoopback.js';

const UID = '3d2c1b0a-9f8e-47d6-b5c4-a3b2c1d0e9f8';

function entry(i: number): AuditEntry {
  return {
    id: `audit-${String(i)}`,
    actorId: i % 2 === 0 ? UID : null,
    actorEmail: i % 2 === 0 ? 'admin@example.com' : null,
    action: i % 2 === 0 ? 'user.update' : 'auth.login_failed',
    target: `user:${String(i)}`,
    before: null,
    after: { i },
    createdAt: new Date(Date.UTC(2026, 9, 16, 12, 0, i)),
  };
}

describe('GET /api/v1/admin/audit (#1315)', () => {
  let server: import('node:http').Server;
  let baseUrl: string;
  const rows = Array.from({ length: 7 }, (_, i) => entry(i));
  const calls: AuditListOptions[] = [];

  before(async () => {
    const app = express();
    app.use(
      '/api/v1/admin/audit',
      createAdminAuditRouter({
        audit: {
          list: async (opts: AuditListOptions = {}) => {
            calls.push(opts);
            const offset = opts.offset ?? 0;
            return rows.slice(offset, offset + (opts.limit ?? 100));
          },
        },
      }),
    );
    server = await listenLoopback(app);
    baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('pages newest-first entries and reports has_more by reading one row ahead', async () => {
    const res = await fetch(`${baseUrl}/api/v1/admin/audit?limit=5`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      entries: Array<Record<string, unknown>>;
      limit: number;
      offset: number;
      has_more: boolean;
    };
    assert.equal(body.entries.length, 5);
    assert.equal(body.has_more, true);
    assert.equal(calls.at(-1)?.limit, 6);
    assert.deepEqual(body.entries[0], {
      id: 'audit-0',
      actor_id: UID,
      actor_email: 'admin@example.com',
      action: 'user.update',
      target: 'user:0',
      before: null,
      after: { i: 0 },
      created_at: '2026-10-16T12:00:00.000Z',
    });

    const last = (await (await fetch(`${baseUrl}/api/v1/admin/audit?limit=5&offset=5`)).json()) as {
      entries: unknown[];
      has_more: boolean;
    };
    assert.equal(last.entries.length, 2);
    assert.equal(last.has_more, false);
  });

  it('passes an action prefix and an actor uuid through', async () => {
    await fetch(`${baseUrl}/api/v1/admin/audit?action=user.&actor_id=${UID}`);
    assert.deepEqual(calls.at(-1), { limit: 51, offset: 0, action: 'user.', actorId: UID });
  });

  it('refuses malformed paging and filters with 400', async () => {
    for (const q of ['limit=0', 'limit=201', 'limit=abc', 'offset=-1', 'action=%25', "action=user'--", 'actor_id=admin@example.com', 'limit=1&limit=2', 'offset=100001']) {
      const res = await fetch(`${baseUrl}/api/v1/admin/audit?${q}`);
      assert.equal(res.status, 400, q);
      assert.equal(((await res.json()) as { code: string }).code, 'admin_audit.invalid_query');
    }
  });
});

describe('AdminAuditLog.list filters', () => {
  function capture(): { pool: Pool; queries: Array<{ text: string; values: unknown[] }> } {
    const queries: Array<{ text: string; values: unknown[] }> = [];
    const pool = {
      query: async (text: string, values: unknown[]) => {
        queries.push({ text, values });
        return { rows: [] };
      },
    } as unknown as Pool;
    return { pool, queries };
  }

  it('binds an exact action, an escaped prefix and the actor as parameters', async () => {
    const { pool, queries } = capture();
    const log = new AdminAuditLog(pool);
    await log.list({ action: 'user.create', limit: 10 });
    await log.list({ action: 'profile_snapshot.', actorId: UID, offset: 20 });
    assert.match(queries[0]!.text, /WHERE action = \$1/);
    assert.deepEqual(queries[0]!.values, ['user.create', 10, 0]);
    assert.match(queries[1]!.text, /WHERE action LIKE \$1 AND actor_id = \$2/);
    assert.deepEqual(queries[1]!.values, ['profile\\_snapshot.%', UID, 100, 20]);
  });
});

describe('auditActorFromRequest (#1315)', () => {
  const req = (session: unknown): express.Request => ({ session }) as unknown as express.Request;

  it('takes the users.id from the uid claim and the email', () => {
    assert.deepEqual(
      auditActorFromRequest(req({ sub: 'a@example.com', email: 'a@example.com', uid: UID, omadia_user_id: 'kg-1' })),
      { id: UID, email: 'a@example.com' },
    );
  });

  it('never puts a non-uuid into the id — not the sub, not the KG id', () => {
    assert.deepEqual(
      auditActorFromRequest(req({ sub: 'a@example.com', email: 'a@example.com', omadia_user_id: 'kg-1' })),
      { email: 'a@example.com' },
    );
    assert.deepEqual(
      auditActorFromRequest(req({ email: 'a@example.com', uid: 'not-a-uuid' })),
      { email: 'a@example.com' },
    );
  });

  it('is the system actor without a session', () => {
    assert.deepEqual(auditActorFromRequest(req(undefined)), {});
  });
});

describe('auditActorFromLabel (#775 class)', () => {
  it('puts only a uuid into the id and keeps any other label as text', () => {
    assert.deepEqual(auditActorFromLabel(UID), { id: UID });
    assert.deepEqual(auditActorFromLabel('conductor-ephemeral-reaper'), { email: 'conductor-ephemeral-reaper' });
    assert.deepEqual(auditActorFromLabel(undefined), {});
  });
});
