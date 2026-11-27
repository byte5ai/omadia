import { strict as assert } from 'node:assert';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';

import express from 'express';

import { InMemoryKnowledgeGraph } from '@omadia/knowledge-graph-inmemory';

import { createMemoryRouter } from '../src/routes/memory.js';

/**
 * #1853 — `/memories` stopped at 50 entries with no way to page, and the
 * owner checks on an existing entry answered 403 `not_an_owner` while an
 * unknown id answered 404, which confirmed that someone else's entry exists.
 */

const ALICE_AAD = '11111111-1111-4111-8111-111111111111';
const BOB_AAD = '22222222-2222-4222-8222-222222222222';

let server: Server;
let base: string;
let kg: InMemoryKnowledgeGraph;
let alice: string;
let bob: string;
let aliceEntry: string;
/** Which user the next request runs as. */
let actingAs = '';

before(async () => {
  kg = new InMemoryKnowledgeGraph();
  alice = (
    await kg.resolveOrCreateChannelIdentity({
      channelKind: 'web',
      channelUserId: 'alice-row',
      aadObjectId: ALICE_AAD,
    })
  ).omadiaUserId;
  bob = (
    await kg.resolveOrCreateChannelIdentity({
      channelKind: 'web',
      channelUserId: 'bob-row',
      aadObjectId: BOB_AAD,
    })
  ).omadiaUserId;
  for (let i = 1; i <= 5; i++) {
    const r = await kg.createMemorableKnowledge({
      kind: 'reference',
      summary: `Cap test entry ${String(i)}`,
      createdBy: 'web:alice-row',
      aclOwners: [alice],
      involvedOmadiaUserIds: [alice],
    });
    aliceEntry = r.memorableKnowledgeNodeId;
  }

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: unknown }).session = {
      omadia_user_id: actingAs,
    };
    next();
  });
  app.use('/memory', createMemoryRouter({ graph: kg }));
  server = await new Promise((done) => {
    const s = app.listen(0, '127.0.0.1', () => { done(s); });
  });
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

after(async () => {
  await new Promise((done) => { server.close(done); });
});

interface ListBody {
  items: Array<{ id: string }>;
  nextCursor: string | null;
}

async function list(query: string): Promise<ListBody> {
  const res = await fetch(`${base}/memory${query}`);
  assert.equal(res.status, 200);
  return (await res.json()) as ListBody;
}

describe('GET /memory paging (#1853)', () => {
  it('pages through every entry with nextCursor', async () => {
    actingAs = alice;
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const q: string =
        cursor === null ? '?limit=2' : `?limit=2&cursor=${cursor}`;
      const body = await list(q);
      seen.push(...body.items.map((n) => n.id));
      cursor = body.nextCursor;
      pages++;
    } while (cursor !== null && pages < 10);
    assert.equal(pages, 3);
    assert.equal(seen.length, 5);
    assert.equal(new Set(seen).size, 5, 'no entry twice');
  });

  it('an exactly full last page offers no further cursor', async () => {
    actingAs = alice;
    const body = await list('?limit=5');
    assert.equal(body.items.length, 5);
    assert.equal(body.nextCursor, null);
  });

  it('rejects a malformed cursor', async () => {
    actingAs = alice;
    const res = await fetch(`${base}/memory?cursor=abc`);
    assert.equal(res.status, 400);
  });
});

describe('owner checks answer 404 like an unknown id (#1853)', () => {
  it('GET /:id/audit of another user’s entry is 404, not 403', async () => {
    actingAs = bob;
    const res = await fetch(
      `${base}/memory/${encodeURIComponent(aliceEntry)}/audit`,
    );
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { code: 'memory.not_found' });
  });

  it('DELETE /:id of another user’s entry is 404, not 403', async () => {
    actingAs = bob;
    const res = await fetch(`${base}/memory/${encodeURIComponent(aliceEntry)}`, {
      method: 'DELETE',
    });
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { code: 'memory.not_found' });
  });
});
