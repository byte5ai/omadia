/**
 * #2295 — the operator path back from a retired turn: list, then un-retire
 * one turn; the audit row is written first and a failed write refuses.
 */
import { strict as assert } from 'node:assert';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';

import express from 'express';

import type { BulkPromotionService, UnretireOutcome } from '@omadia/plugin-api';

import type { AdminAuditLog } from '../src/auth/adminAuditLog.js';
import { createBulkPromotionRouter } from '../src/routes/bulkPromotion.js';
import { listenLoopback } from './_helpers/listenLoopback.js';

const SESSION = { sub: 'op@example.com', uid: '5d2e7a90-2222-4333-8444-a55566667777', omadia_user_id: 'op-1' };

function service(outcome: UnretireOutcome, calls: string[]): BulkPromotionService {
  return {
    preview: () => Promise.reject(new Error('unused')),
    run: () => Promise.reject(new Error('unused')),
    listRetired: () =>
      Promise.resolve([{ turnId: 'turn:a', reason: 'memory_deleted', retiredAt: '2026-11-12T00:00:00.000Z', agentSlug: 'desk' }]),
    unretire: (turnId) => {
      calls.push(turnId);
      return Promise.resolve(outcome);
    },
  };
}

async function start(svc: BulkPromotionService, adminAudit?: Pick<AdminAuditLog, 'record'>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: unknown }).session = SESSION;
    next();
  });
  app.use('/bp', createBulkPromotionRouter({ service: svc, ...(adminAudit ? { adminAudit: adminAudit as AdminAuditLog } : {}) }));
  const server: Server = await listenLoopback(app);
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}/bp`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

const post = (url: string, body: unknown) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('#2295 — bulk-promote /retired and /unretire', () => {
  it('lists retired turns without their text', async () => {
    const h = await start(service('unretired', []));
    try {
      const res = await fetch(`${h.url}/retired`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as { turns: Array<Record<string, unknown>> };
      assert.deepEqual(Object.keys(body.turns[0] ?? {}).sort(), ['agentSlug', 'reason', 'retiredAt', 'turnId']);
    } finally {
      await h.close();
    }
  });

  it('un-retires after recording the audit row', async () => {
    const calls: string[] = [];
    const audits: unknown[] = [];
    const h = await start(service('unretired', calls), {
      record: (entry) => {
        audits.push(entry);
        return Promise.resolve();
      },
    });
    try {
      const res = await post(`${h.url}/unretire`, { turnId: 'turn:a' });
      assert.equal(res.status, 200);
      assert.deepEqual(calls, ['turn:a']);
      assert.equal((audits[0] as { action: string }).action, 'memory.promotion_unretire');
      assert.equal((audits[0] as { target: string }).target, 'turn:turn:a');
    } finally {
      await h.close();
    }
  });

  it('refuses when the audit row cannot be written, and changes nothing', async () => {
    const calls: string[] = [];
    const h = await start(service('unretired', calls), { record: () => Promise.reject(new Error('db down')) });
    try {
      const res = await post(`${h.url}/unretire`, { turnId: 'turn:a' });
      assert.equal(res.status, 500);
      assert.deepEqual(calls, []);
    } finally {
      await h.close();
    }
  });

  it('maps not_found to 404 and no_person_owner to 409', async () => {
    for (const [outcome, status] of [['not_found', 404], ['no_person_owner', 409]] as const) {
      const h = await start(service(outcome, []));
      try {
        const res = await post(`${h.url}/unretire`, { turnId: 'turn:x' });
        assert.equal(res.status, status);
        assert.equal(((await res.json()) as { code: string }).code, `bulk.unretire_${outcome}`);
      } finally {
        await h.close();
      }
    }
  });
});
