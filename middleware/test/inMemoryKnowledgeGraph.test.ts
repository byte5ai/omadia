import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { InMemoryKnowledgeGraph } from '@omadia/knowledge-graph-inmemory';
import type { EntityRef } from '@omadia/plugin-api';

const ref = (system: 'odoo' | 'confluence', model: string, id: number | string, name?: string): EntityRef => ({
  system,
  model,
  id,
  displayName: name,
  op: 'read',
});

describe('InMemoryKnowledgeGraph.ingestTurn', () => {
  it('creates Session + Turn + IN_SESSION edge for a new scope', async () => {
    const g = new InMemoryKnowledgeGraph();
    const result = await g.ingestTurn({
      scope: 'demo',
      time: '2026-04-18T10:00:00Z',
      userMessage: 'Hallo',
      assistantAnswer: 'Hi',
      toolCalls: 0,
      iterations: 1,
      entityRefs: [],
    });
    assert.equal(result.sessionId, 'session:demo');
    assert.equal(result.turnId, 'turn:demo:2026-04-18T10:00:00Z');

    const stats = await g.stats();
    assert.equal(stats.byNodeType.Session, 1);
    assert.equal(stats.byNodeType.Turn, 1);
    assert.equal(stats.byEdgeType.IN_SESSION, 1);
    assert.equal(stats.byEdgeType.NEXT_TURN, 0);
  });

  it('chains turns of the same session via NEXT_TURN in chronological order', async () => {
    const g = new InMemoryKnowledgeGraph();
    // Ingest out-of-order on purpose to verify chronological linking.
    await g.ingestTurn({
      scope: 's', time: '2026-04-18T12:00:00Z',
      userMessage: 'b', assistantAnswer: 'B', entityRefs: [],
    });
    await g.ingestTurn({
      scope: 's', time: '2026-04-18T10:00:00Z',
      userMessage: 'a', assistantAnswer: 'A', entityRefs: [],
    });
    await g.ingestTurn({
      scope: 's', time: '2026-04-18T11:00:00Z',
      userMessage: 'mid', assistantAnswer: 'M', entityRefs: [],
    });

    const view = await g.getSession('s');
    assert.ok(view);
    assert.equal(view.turns.length, 3);
    assert.deepEqual(
      view.turns.map((t) => t.turn.props['userMessage']),
      ['a', 'mid', 'b'],
    );

    const stats = await g.stats();
    // NEXT_TURN edges: (a→mid), (mid→b). The out-of-order insert should have
    // been fixed up on the second ingest.
    assert.equal(stats.byEdgeType.NEXT_TURN, 2);
  });

  it('upserts entity nodes and CAPTURED edges, merging displayName later', async () => {
    const g = new InMemoryKnowledgeGraph();
    await g.ingestTurn({
      scope: 'x', time: '2026-04-18T10:00:00Z',
      userMessage: 'q1', assistantAnswer: 'a1',
      entityRefs: [ref('odoo', 'hr.employee', 42)], // no name
    });
    await g.ingestTurn({
      scope: 'x', time: '2026-04-18T10:05:00Z',
      userMessage: 'q2', assistantAnswer: 'a2',
      entityRefs: [ref('odoo', 'hr.employee', 42, 'Müller, Anna')], // now with name
    });

    const neighbors = await g.getNeighbors('odoo:hr.employee:42');
    // Employee is connected to both turns via CAPTURED.
    const turnIds = neighbors.filter((n) => n.type === 'Turn').map((n) => n.id);
    assert.equal(turnIds.length, 2);

    const view = await g.getSession('x');
    const entity = view?.turns[1]?.entities[0];
    assert.equal(entity?.props['displayName'], 'Müller, Anna');
    assert.equal(entity?.props['externalId'], 42);
  });

  it('treats odoo vs confluence as distinct node types', async () => {
    const g = new InMemoryKnowledgeGraph();
    await g.ingestTurn({
      scope: 's', time: '2026-04-18T10:00:00Z',
      userMessage: 'q', assistantAnswer: 'a',
      entityRefs: [
        ref('odoo', 'res.partner', 7, 'Acme'),
        ref('confluence', 'confluence.page', '100', 'Handbook'),
      ],
    });
    const stats = await g.stats();
    assert.equal(stats.byNodeType.OdooEntity, 1);
    assert.equal(stats.byNodeType.ConfluencePage, 1);
  });

  it('listSessions summarises by last-activity (most-recent first)', async () => {
    const g = new InMemoryKnowledgeGraph();
    await g.ingestTurn({
      scope: 'old', time: '2026-04-17T10:00:00Z',
      userMessage: 'q', assistantAnswer: 'a', entityRefs: [],
    });
    await g.ingestTurn({
      scope: 'recent', time: '2026-04-18T10:00:00Z',
      userMessage: 'q', assistantAnswer: 'a', entityRefs: [],
    });
    const sessions = await g.listSessions();
    assert.deepEqual(sessions.map((s) => s.scope), ['recent', 'old']);
    assert.equal(sessions[0]?.turnCount, 1);
  });

  it('getNeighbors returns deduplicated neighbors for shared entities', async () => {
    const g = new InMemoryKnowledgeGraph();
    // Two turns both referencing employee 1 — neighbor list of the employee
    // should include each turn once, not twice per edge.
    for (const t of ['10:00:00Z', '11:00:00Z']) {
      await g.ingestTurn({
        scope: 's', time: `2026-04-18T${t}`,
        userMessage: 'q', assistantAnswer: 'a',
        entityRefs: [ref('odoo', 'hr.employee', 1)],
      });
    }
    const neighbors = await g.getNeighbors('odoo:hr.employee:1');
    const turns = neighbors.filter((n) => n.type === 'Turn');
    assert.equal(turns.length, 2);
    // And no duplicates:
    assert.equal(new Set(turns.map((t) => t.id)).size, 2);
  });

  it('returns null for unknown session scope', async () => {
    const g = new InMemoryKnowledgeGraph();
    assert.equal(await g.getSession('nonexistent'), null);
  });
});
