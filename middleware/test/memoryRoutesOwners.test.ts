/**
 * #1821 / #1852 — owners of a memory entry are real users, and only the
 * saver decides who they are.
 *
 *  - Create: the saver is the only owner and involved user; naming anyone
 *    else is refused; a source turn the saver did not send is dropped.
 *  - Add owner: an unknown user is refused (400), a real one gets the entry
 *    in their `GET /memory` list (INVOLVED edge); remove drops it again.
 */
import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import express from 'express';
import { InMemoryKnowledgeGraph } from '@omadia/knowledge-graph-inmemory';

import { createMemoryRouter } from '../src/routes/memory.js';
import { listenLoopback } from './_helpers/listenLoopback.js';

const UNKNOWN = '00000000-0000-4000-8000-000000000000';

describe('#1821 / #1852 — memory owners', () => {
  let server: Server;
  let base: string;
  let graph: InMemoryKnowledgeGraph;
  let anna: string;
  let ben: string;
  let bensTurn: string;
  let annasTurn: string;
  let bensAgentTurn: string;

  before(async () => {
    graph = new InMemoryKnowledgeGraph();
    const user = async (name: string): Promise<string> =>
      (
        await graph.resolveOrCreateChannelIdentity({
          channelKind: 'teams',
          channelUserId: `aad-${name}`,
          aadObjectId: `aad-${name}`,
          displayName: name,
        })
      ).omadiaUserId;
    anna = await user('anna');
    ben = await user('ben');
    const turnOf = async (userId: string, scope: string): Promise<string> => {
      const at = new Date().toISOString();
      const res = await graph.ingestTurn({
        scope,
        time: at,
        userMessage: 'Preisliste Z',
        assistantAnswer: 'Notiert.',
        entityRefs: [],
        userId,
      });
      await graph.ingestRun({
        turnId: res.turnId,
        scope,
        userId,
        startedAt: at,
        finishedAt: at,
        durationMs: 1,
        status: 'success',
        iterations: 1,
        orchestratorToolCalls: [],
        agentInvocations: [],
      });
      return res.turnId;
    };
    annasTurn = await turnOf(anna, 'web-anna');
    bensTurn = await turnOf(ben, 'web-ben');
    bensAgentTurn = await turnOf(ben, 'atlas::web-ben');

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      const id = req.header('x-test-user');
      (req as unknown as { session: unknown }).session = id ? { omadia_user_id: id } : undefined;
      next();
    });
    app.use('/api/v1/memory', createMemoryRouter({ graph }));
    server = await listenLoopback(app);
    base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/api/v1/memory`;
  });

  after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  const call = async (
    userId: string,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: Record<string, unknown> }> => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-test-user': userId },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const listIds = async (userId: string): Promise<string[]> =>
    ((await call(userId, 'GET', '?limit=100')).body['items'] as { id: string }[]).map((n) => n.id);
  const create = (userId: string, extra: Record<string, unknown> = {}) =>
    call(userId, 'POST', '', { kind: 'reference', summary: 'Ab jetzt gilt Preisliste Z.', ...extra });

  it('#1852: refuses another person as owner or involved user on create', async () => {
    for (const extra of [{ aclOwners: [anna] }, { involvedOmadiaUserIds: [anna] }]) {
      const res = await create(ben, extra);
      assert.equal(res.status, 400);
      assert.equal(res.body['code'], 'memory.foreign_owner');
    }
    assert.deepEqual(await listIds(anna), []);
  });

  it('#1852: naming only yourself still works; the saver is the only owner', async () => {
    const res = await create(ben, { aclOwners: [ben], involvedOmadiaUserIds: [ben] });
    assert.equal(res.status, 201);
    const id = String(res.body['memorableKnowledgeNodeId']);
    const node = (await graph.getMemorableKnowledge(id))!;
    assert.deepEqual(node.props['acl_owners'], [ben]);
  });

  it('#1852: keeps a source turn the saver sent and drops another person’s', async () => {
    const res = await create(ben, { derivedFromTurnIds: [bensTurn, annasTurn, 'turn:missing'] });
    assert.equal(res.status, 201);
    assert.equal(res.body['droppedSourceTurns'], 2);
    const id = String(res.body['memorableKnowledgeNodeId']);
    const neighbours = (await graph.getNeighbors(id)).map((n) => n.id);
    assert.ok(neighbours.includes(bensTurn), 'own turn linked');
    assert.ok(!neighbours.includes(annasTurn), 'foreign turn not linked');
  });

  it('#1821: an unknown user cannot become owner; a real one sees the entry, until removed', async () => {
    const created = await create(anna);
    const id = String(created.body['memorableKnowledgeNodeId']);
    const e = encodeURIComponent(id);

    const unknown = await call(anna, 'POST', `/${e}/owners`, { omadiaUserId: UNKNOWN });
    assert.equal(unknown.status, 400);
    assert.equal(unknown.body['code'], 'memory.unknown_user');
    assert.deepEqual((await graph.getMemorableKnowledge(id))!.props['acl_owners'], [anna]);

    assert.ok(!(await listIds(ben)).includes(id));
    const added = await call(anna, 'POST', `/${e}/owners`, { omadiaUserId: ben });
    assert.equal(added.status, 200);
    assert.ok((await listIds(ben)).includes(id), 'the new owner lists it');

    const removed = await call(anna, 'DELETE', `/${e}/owners/${ben}`);
    assert.equal(removed.status, 200);
    assert.ok(!(await listIds(ben)).includes(id), 'gone from the removed owner’s list');
    assert.ok((await listIds(anna)).includes(id));
  });

  it('#1823: a saved memory is private and belongs to the agent of its source turn', async () => {
    const res = await create(ben, { derivedFromTurnIds: [bensAgentTurn] });
    assert.equal(res.status, 201);
    const node = (await graph.getMemorableKnowledge(String(res.body['memorableKnowledgeNodeId'])))!;
    assert.equal(node.visibility, 'private');
    assert.equal(node.props['origin_agent'], 'atlas');
  });
});
