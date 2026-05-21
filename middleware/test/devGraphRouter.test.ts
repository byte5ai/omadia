import { describe, it, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { InMemoryKnowledgeGraph } from '@omadia/knowledge-graph-inmemory';
import { createDevGraphRouter } from '../src/routes/devGraph.js';

describe('/api/dev/graph router', () => {
  let server: import('node:http').Server;
  let baseUrl: string;
  const graph = new InMemoryKnowledgeGraph();

  before(async () => {
    const app = express();
    app.use('/api/dev/graph', createDevGraphRouter({ graph }));
    server = app.listen(0);
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${String(addr.port)}/api/dev/graph`;

    // Seed: two turns, one shared entity, two distinct entities.
    await graph.ingestTurn({
      scope: 'demo',
      time: '2026-04-18T10:00:00Z',
      userMessage: 'Q1',
      assistantAnswer: 'A1',
      entityRefs: [
        { system: 'odoo', model: 'hr.employee', id: 1, displayName: 'Alice', op: 'read' },
        { system: 'confluence', model: 'confluence.page', id: '100', displayName: 'Wiki', op: 'read' },
      ],
    });
    await graph.ingestTurn({
      scope: 'demo',
      time: '2026-04-18T10:05:00Z',
      userMessage: 'Q2',
      assistantAnswer: 'A2',
      entityRefs: [
        { system: 'odoo', model: 'hr.employee', id: 1, displayName: 'Alice', op: 'read' },
        { system: 'odoo', model: 'hr.employee', id: 2, displayName: 'Bob', op: 'read' },
      ],
    });
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => { resolve(); }));
  });

  it('GET /stats returns node and edge counts', async () => {
    const res = await fetch(`${baseUrl}/stats`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      nodes: number;
      edges: number;
      byNodeType: Record<string, number>;
      byEdgeType: Record<string, number>;
    };
    assert.equal(body.byNodeType['Session'], 1);
    assert.equal(body.byNodeType['Turn'], 2);
    assert.equal(body.byNodeType['OdooEntity'], 2);
    assert.equal(body.byNodeType['ConfluencePage'], 1);
    assert.equal(body.byEdgeType['NEXT_TURN'], 1);
  });

  it('GET /sessions lists the session', async () => {
    const res = await fetch(`${baseUrl}/sessions`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { sessions: Array<{ scope: string; turnCount: number }> };
    assert.equal(body.sessions.length, 1);
    assert.equal(body.sessions[0]?.scope, 'demo');
    assert.equal(body.sessions[0]?.turnCount, 2);
  });

  it('GET /session/:scope returns turns with entities', async () => {
    const res = await fetch(`${baseUrl}/session/demo`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      turns: Array<{ turn: { props: Record<string, unknown> }; entities: unknown[] }>;
    };
    assert.equal(body.turns.length, 2);
    assert.equal(body.turns[0]?.entities.length, 2);
    assert.equal(body.turns[1]?.entities.length, 2);
  });

  it('GET /session/:scope returns 404 for unknown scope', async () => {
    const res = await fetch(`${baseUrl}/session/does-not-exist`);
    assert.equal(res.status, 404);
  });

  it('GET /neighbors returns direct neighbors of a node', async () => {
    const res = await fetch(`${baseUrl}/neighbors?nodeId=odoo:hr.employee:1`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { neighbors: Array<{ type: string }> };
    const turnCount = body.neighbors.filter((n) => n.type === 'Turn').length;
    assert.equal(turnCount, 2);
  });

  it('GET /neighbors requires the nodeId query param', async () => {
    const res = await fetch(`${baseUrl}/neighbors`);
    assert.equal(res.status, 400);
  });

  it('GET /memories returns empty result when no MKs exist', async () => {
    const res = await fetch(`${baseUrl}/memories?scope=demo`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      memories: unknown[];
      edges: unknown[];
      scope: string;
    };
    assert.equal(body.memories.length, 0);
    assert.equal(body.edges.length, 0);
    assert.equal(body.scope, 'demo');
  });
});

describe('/api/dev/graph router · memories endpoint', () => {
  let server: import('node:http').Server;
  let baseUrl: string;
  const graph = new InMemoryKnowledgeGraph();
  let mkId = '';

  before(async () => {
    const app = express();
    app.use('/api/dev/graph', createDevGraphRouter({ graph }));
    server = app.listen(0);
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${String(addr.port)}/api/dev/graph`;

    const ident = await graph.resolveOrCreateChannelIdentity({
      channelKind: 'web',
      channelUserId: 'mem-test-user-uuid',
    });

    await graph.ingestTurn({
      scope: 'memscope',
      time: '2026-05-15T07:00:00Z',
      userMessage: 'remember Alice',
      assistantAnswer: 'noted',
      userId: ident.omadiaUserId,
      entityRefs: [
        {
          system: 'odoo',
          model: 'hr.employee',
          id: 42,
          displayName: 'Alice',
          op: 'read',
        },
      ],
    });

    const mk = await graph.createMemorableKnowledge({
      kind: 'fact',
      summary: 'Alice prefers Slack',
      createdBy: ident.channelIdentityNodeId,
      involvedOmadiaUserIds: [ident.omadiaUserId],
      requiredEntityIds: ['odoo:hr.employee:42'],
      derivedFromTurnIds: ['turn:memscope:2026-05-15T07:00:00Z'],
      aclOwners: [ident.omadiaUserId],
      actorOmadiaUserId: ident.omadiaUserId,
      palaiaExcerpts: {
        texts: ['Alice prefers Slack over Teams.'],
        source: 'llm',
      },
    });
    mkId = mk.memorableKnowledgeNodeId;
  });

  after(async () => {
    await new Promise<void>((resolve) =>
      server.close(() => {
        resolve();
      }),
    );
  });

  it('returns MK with 2-hop provenance ancestors for a scope', async () => {
    const res = await fetch(`${baseUrl}/memories?scope=memscope`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      memories: Array<{
        node: { id: string; type: string };
        level1: Array<{ type: string }>;
        level2: Array<{ type: string }>;
      }>;
      edges: Array<{ from: string; to: string; type: string }>;
      scope: string;
    };
    assert.equal(body.scope, 'memscope');
    const mkRows = body.memories.filter((m) => m.node.type === 'MemorableKnowledge');
    assert.equal(mkRows.length, 1);
    const mk = mkRows[0]!;
    assert.equal(mk.node.id, mkId);
    // Lvl-1: Turn + User + Entity
    const lvl1Types = mk.level1.map((n) => n.type).sort();
    assert.deepEqual(lvl1Types, ['OdooEntity', 'Turn', 'User']);
    // Lvl-2: Session
    assert.equal(mk.level2.length, 1);
    assert.equal(mk.level2[0]?.type, 'Session');
    // Excerpt row attached after the MK with MK as its sole Lvl-1.
    const excerptRows = body.memories.filter(
      (m) => m.node.type === 'PalaiaExcerpt',
    );
    assert.equal(excerptRows.length, 1);
    assert.equal(excerptRows[0]?.level1.length, 1);
    assert.equal(excerptRows[0]?.level1[0]?.type, 'MemorableKnowledge');
    // Edges include DERIVED_FROM, IN_SESSION, INVOLVED, REQUIRES, EXCERPT_OF.
    const edgeTypes = new Set(body.edges.map((e) => e.type));
    assert.ok(edgeTypes.has('DERIVED_FROM'));
    assert.ok(edgeTypes.has('IN_SESSION'));
    assert.ok(edgeTypes.has('INVOLVED'));
    assert.ok(edgeTypes.has('REQUIRES'));
    assert.ok(edgeTypes.has('EXCERPT_OF'));
  });

  it('returns the same MK in __ALL__ mode', async () => {
    const res = await fetch(`${baseUrl}/memories?scope=__ALL__`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      memories: Array<{ node: { id: string; type: string } }>;
      scope: string;
    };
    assert.equal(body.scope, '__ALL__');
    assert.ok(
      body.memories.some(
        (m) => m.node.type === 'MemorableKnowledge' && m.node.id === mkId,
      ),
    );
  });

  it('respects includeExcerpts=false', async () => {
    const res = await fetch(
      `${baseUrl}/memories?scope=memscope&includeExcerpts=false`,
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      memories: Array<{ node: { type: string } }>;
    };
    assert.equal(
      body.memories.filter((m) => m.node.type === 'PalaiaExcerpt').length,
      0,
    );
  });

  it('rejects invalid limit', async () => {
    const res = await fetch(`${baseUrl}/memories?scope=memscope&limit=foo`);
    assert.equal(res.status, 400);
  });
});
