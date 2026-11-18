import { describe, it, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import express from 'express';
import type { Express } from 'express';

import { createDuplicatesRouter } from '../src/routes/duplicates.js';

// `GET /excerpts` used to register after `GET /:id`, so Express read `excerpts`
// as a MergeCandidate id and the list answered `duplicates.not_found`.

describe('GET /duplicates route order', () => {
  let server: Server;
  let baseUrl: string;
  const excerptListCalls: unknown[] = [];
  const candidateLookups: string[] = [];

  before(async () => {
    const graph = {
      listExcerptMergeCandidates: (opts: unknown) => {
        excerptListCalls.push(opts);
        return Promise.resolve([]);
      },
      getMergeCandidate: (id: string) => {
        candidateLookups.push(id);
        return Promise.resolve(null);
      },
    };
    const app: Express = express();
    app.use((req, _res, next) => {
      (req as unknown as { session: unknown }).session = { omadia_user_id: 'user-1' };
      next();
    });
    app.use('/duplicates', createDuplicatesRouter({ graph: graph as never }));
    server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('serves the excerpt list instead of treating `excerpts` as an id', async () => {
    const res = await fetch(`${baseUrl}/duplicates/excerpts?status=open&limit=5`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { items: [] });
    assert.deepEqual(excerptListCalls, [
      { viewerOmadiaUserId: 'user-1', status: 'open', limit: 5 },
    ]);
    assert.deepEqual(candidateLookups, []);
  });

  it('still resolves an ordinary id through GET /:id', async () => {
    const res = await fetch(`${baseUrl}/duplicates/mc-1`);
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { code: 'duplicates.not_found' });
    assert.deepEqual(candidateLookups, ['mc-1']);
  });
});
