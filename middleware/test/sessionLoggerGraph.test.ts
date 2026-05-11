import { describe, it, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FilesystemMemoryStore } from '@omadia/memory';
import { InMemoryKnowledgeGraph } from '@omadia/knowledge-graph-inmemory';
import { SessionLogger } from '@omadia/orchestrator';

describe('SessionLogger + KnowledgeGraph integration', () => {
  let dir: string;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'sl-graph-'));
  });
  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes markdown AND ingests a Turn node on every log()', async () => {
    const store = new FilesystemMemoryStore(dir);
    await store.init();
    const graph = new InMemoryKnowledgeGraph();
    const logger = new SessionLogger(store, graph);

    await logger.log({
      scope: 'integration-test',
      userMessage: 'Wer ist für das Onboarding zuständig?',
      assistantAnswer: 'Anna Müller (Engineering).',
      toolCalls: 2,
      iterations: 1,
      entityRefs: [
        { system: 'odoo', model: 'hr.employee', id: 42, displayName: 'Müller, Anna', op: 'read' },
        { system: 'confluence', model: 'confluence.page', id: '100', displayName: 'Onboarding', op: 'read' },
      ],
    });

    // markdown side
    const sessions = await store.list('/memories/sessions/integration-test');
    const files = sessions.filter((e) => !e.isDirectory);
    assert.equal(files.length, 1);

    // graph side
    const stats = await graph.stats();
    assert.equal(stats.byNodeType.Session, 1);
    assert.equal(stats.byNodeType.Turn, 1);
    assert.equal(stats.byNodeType.OdooEntity, 1);
    assert.equal(stats.byNodeType.ConfluencePage, 1);
    assert.equal(stats.byEdgeType.CAPTURED, 2);
    assert.equal(stats.byEdgeType.IN_SESSION, 1);
    assert.equal(stats.byEdgeType.NEXT_TURN, 0);

    const view = await graph.getSession('integration-test');
    assert.ok(view);
    assert.equal(view.turns.length, 1);
    assert.equal(view.turns[0]?.entities.length, 2);
  });

  it('graph ingest failure does not break the markdown write', async () => {
    const store = new FilesystemMemoryStore(dir);
    await store.init();
    // A sabotaged graph that throws on every ingestTurn; SessionLogger must
    // still write the transcript.
    const badGraph: Parameters<typeof SessionLogger>[1] = {
      ingestTurn: async () => {
        throw new Error('boom');
      },
      getSession: async () => null,
      listSessions: async () => [],
      getNeighbors: async () => [],
      stats: async () => ({
        nodes: 0,
        edges: 0,
        byNodeType: { Session: 0, Turn: 0, OdooEntity: 0, ConfluencePage: 0 },
        byEdgeType: { IN_SESSION: 0, NEXT_TURN: 0, CAPTURED: 0 },
      }),
    };
    const logger = new SessionLogger(store, badGraph);
    await logger.log({
      scope: 'sabotage',
      userMessage: 'q',
      assistantAnswer: 'a',
      entityRefs: [],
    });
    const entries = await store.list('/memories/sessions/sabotage');
    assert.ok(entries.some((e) => !e.isDirectory));
  });

  it('works without a graph at all (backward-compat)', async () => {
    const store = new FilesystemMemoryStore(dir);
    await store.init();
    const logger = new SessionLogger(store);
    await logger.log({
      scope: 'no-graph',
      userMessage: 'q',
      assistantAnswer: 'a',
      entityRefs: [],
    });
    const entries = await store.list('/memories/sessions/no-graph');
    assert.ok(entries.some((e) => !e.isDirectory));
  });
});
