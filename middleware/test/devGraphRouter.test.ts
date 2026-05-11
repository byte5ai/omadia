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
});
