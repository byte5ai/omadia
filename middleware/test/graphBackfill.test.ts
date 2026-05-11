import { describe, it, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FilesystemMemoryStore } from '@omadia/memory';
import { InMemoryKnowledgeGraph } from '@omadia/knowledge-graph-inmemory';
import { SessionLogger } from '@omadia/orchestrator';
import { backfillGraph } from '@omadia/orchestrator-extras';

describe('backfillGraph', () => {
  let dir: string;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'backfill-'));
  });
  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('rebuilds a graph identical in shape to live ingest', async () => {
    // 1. Create an "original" session by logging through the real pipeline.
    const store = new FilesystemMemoryStore(dir);
    await store.init();
    const liveGraph = new InMemoryKnowledgeGraph();
    const logger = new SessionLogger(store, liveGraph);

    await logger.log({
      scope: 'backfill',
      userMessage: 'Q1',
      assistantAnswer: 'A1',
      toolCalls: 2,
      iterations: 1,
      entityRefs: [
        { system: 'odoo', model: 'hr.employee', id: 42, displayName: 'Anna', op: 'read' },
      ],
    });
    await logger.log({
      scope: 'backfill',
      userMessage: 'Q2',
      assistantAnswer: 'A2',
      toolCalls: 1,
      iterations: 1,
      entityRefs: [
        { system: 'confluence', model: 'confluence.page', id: '100', displayName: 'Wiki', op: 'read' },
      ],
    });

    // 2. Build a fresh graph and replay from the stored markdown.
    const restored = new InMemoryKnowledgeGraph();
    const result = await backfillGraph(store, restored);

    assert.equal(result.scopes, 1);
    assert.equal(result.turns, 2);
    assert.equal(result.skippedFiles.length, 0);

    // 3. The restored graph should match the live one on the node/edge
    //    counts that matter — same session, same turns, same entities.
    const liveStats = await liveGraph.stats();
    const restoredStats = await restored.stats();
    assert.deepEqual(restoredStats.byNodeType, liveStats.byNodeType);
    assert.deepEqual(restoredStats.byEdgeType, liveStats.byEdgeType);

    const view = await restored.getSession('backfill');
    assert.ok(view);
    assert.equal(view.turns.length, 2);
    assert.equal(view.turns[0]?.entities[0]?.props['displayName'], 'Anna');
    assert.equal(view.turns[1]?.entities[0]?.props['displayName'], 'Wiki');
  });

  it('returns an empty result when no sessions directory exists', async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'backfill-empty-'));
    try {
      const store = new FilesystemMemoryStore(emptyDir);
      await store.init();
      const graph = new InMemoryKnowledgeGraph();
      const result = await backfillGraph(store, graph);
      assert.deepEqual(result, {
        scopes: 0,
        files: 0,
        turns: 0,
        skippedFiles: [],
      });
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});
