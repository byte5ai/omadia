import { strict as assert } from 'node:assert';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';

import express from 'express';
import type { NextFunction, Request, Response } from 'express';

import { InMemoryKnowledgeGraph } from '@omadia/knowledge-graph-inmemory';

import { createDatasetsRouter } from '../src/routes/datasets.js';

/**
 * HTTP integration test for the #430 datasets REST surface, mirroring the
 * `memoryPurgeRoute.test.ts` pattern: a real express `listen(0)` server over
 * a real `InMemoryKnowledgeGraph`. `requireAuth` is applied at MOUNT time in
 * prod, not inside the router, so the test injects `req.session` directly
 * via a tiny fixture middleware instead of exercising real auth.
 */

const MOUNT = '/api/v1/datasets';

interface Harness {
  baseUrl: string;
  graph: InMemoryKnowledgeGraph;
  close: () => Promise<void>;
}

function withSession(userId: string | undefined) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    (req as Request & { session?: { omadia_user_id?: string } }).session = userId
      ? { omadia_user_id: userId }
      : {};
    next();
  };
}

// No default value here on purpose — a default would silently win over an
// explicit `undefined` argument (JS default-parameter semantics), which is
// exactly the "anonymous caller" case this harness needs to express.
async function makeHarness(userId: string | undefined): Promise<Harness> {
  const graph = new InMemoryKnowledgeGraph();
  const app = express();
  app.use(express.json());
  app.use(MOUNT, withSession(userId), createDatasetsRouter({ graph }));
  const server: Server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${String(port)}${MOUNT}`,
    graph,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const CSV = 'name,age\nAda,36\nGrace,85\n';

describe('POST /api/v1/datasets', () => {
  let h: Harness;
  before(async () => {
    h = await makeHarness('user-1');
  });
  after(() => h.close());

  it('401s without a session', async () => {
    const anon = await makeHarness(undefined);
    const res = await fetch(anon.baseUrl, { method: 'GET' });
    assert.equal(res.status, 401);
    await anon.close();
  });

  it('rejects a non-CSV upload with 422', async () => {
    const form = new FormData();
    form.append('file', new Blob(['hello'], { type: 'text/plain' }), 'notes.txt');
    const res = await fetch(h.baseUrl, { method: 'POST', body: form });
    assert.equal(res.status, 422);
  });

  it('uploads a CSV, lists it, reads its schema + rows, then deletes it', async () => {
    const form = new FormData();
    form.append('file', new Blob([CSV], { type: 'text/csv' }), 'people.csv');
    form.append('name', 'People');
    const uploadRes = await fetch(h.baseUrl, { method: 'POST', body: form });
    assert.equal(uploadRes.status, 201);
    const uploadBody = (await uploadRes.json()) as {
      dataset: { datasetId: string; rowCount: number };
    };
    assert.equal(uploadBody.dataset.rowCount, 2);
    const { datasetId } = uploadBody.dataset;

    const listRes = await fetch(h.baseUrl);
    const listBody = (await listRes.json()) as { items: Array<{ id: string; name: string }> };
    assert.equal(listBody.items.length, 1);
    assert.equal(listBody.items[0]?.name, 'People');

    const schemaRes = await fetch(`${h.baseUrl}/${datasetId}`);
    const schemaBody = (await schemaRes.json()) as { columns: Array<{ name: string }> };
    assert.deepEqual(
      schemaBody.columns.map((c) => c.name),
      ['name', 'age'],
    );

    const rowsRes = await fetch(`${h.baseUrl}/${datasetId}/rows`);
    const rowsBody = (await rowsRes.json()) as { rows: Array<Record<string, unknown>> };
    assert.equal(rowsBody.rows.length, 2);

    const deleteRes = await fetch(`${h.baseUrl}/${datasetId}`, { method: 'DELETE' });
    assert.equal(deleteRes.status, 204);
    const afterDeleteRes = await fetch(`${h.baseUrl}/${datasetId}`);
    assert.equal(afterDeleteRes.status, 404);
  });

  it('scopes datasets per owner — a different session cannot see or delete them', async () => {
    const form = new FormData();
    form.append('file', new Blob([CSV], { type: 'text/csv' }), 'people.csv');
    const uploadRes = await fetch(h.baseUrl, { method: 'POST', body: form });
    const { dataset } = (await uploadRes.json()) as { dataset: { datasetId: string } };

    const other = await makeHarness('user-2');
    const getRes = await fetch(`${other.baseUrl}/${dataset.datasetId}`);
    assert.equal(getRes.status, 404);
    const deleteRes = await fetch(`${other.baseUrl}/${dataset.datasetId}`, {
      method: 'DELETE',
    });
    assert.equal(deleteRes.status, 404);
    await other.close();
  });
});
