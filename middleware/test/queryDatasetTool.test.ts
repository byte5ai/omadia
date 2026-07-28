import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { InMemoryKnowledgeGraph } from '@omadia/knowledge-graph-inmemory';

// Imported from the SAME relative source path `queryDatasetTool.ts` itself
// uses (not the built `@omadia/orchestrator` package) — tsx loads test files
// straight from source, so importing the compiled package here would create
// a SECOND module instance with its own AsyncLocalStorage, and turnContext
// set in the test would never be visible inside the tool.
import { turnContext } from '../packages/harness-orchestrator/src/turnContext.js';
import { QueryDatasetTool } from '../packages/harness-orchestrator/src/tools/queryDatasetTool.js';

function asUser(userId: string, fn: () => Promise<string>): Promise<string> {
  return turnContext.run({ turnId: 't', turnDate: '2026-01-01', userId }, fn);
}

describe('QueryDatasetTool', () => {
  it('returns an error string (not a throw) when no user identity is resolved', async () => {
    const graph = new InMemoryKnowledgeGraph();
    const tool = new QueryDatasetTool(graph);
    const out = await tool.handle({ query: 'list_datasets' });
    assert.match(out, /Error:.*user identity/);
  });

  it('list_datasets, get_schema, and query_rows round-trip for the owning user', async () => {
    const graph = new InMemoryKnowledgeGraph();
    const { datasetId } = await graph.ingestDataset({
      ownerOmadiaUserId: 'user-1',
      name: 'Sales',
      sourceFileName: 'sales.csv',
      columns: [
        { name: 'region', type: 'string' },
        { name: 'amount', type: 'number' },
      ],
      rows: [
        { region: 'North', amount: 100 },
        { region: 'South', amount: 250 },
      ],
    });
    const tool = new QueryDatasetTool(graph);

    const listed = await asUser('user-1', () => tool.handle({ query: 'list_datasets' }));
    const listedJson = JSON.parse(listed) as { datasets: Array<{ id: string }> };
    assert.equal(listedJson.datasets.length, 1);
    assert.equal(listedJson.datasets[0]?.id, datasetId);

    const schema = await asUser('user-1', () =>
      tool.handle({ query: 'get_schema', dataset_id: datasetId }),
    );
    const schemaJson = JSON.parse(schema) as { columns: Array<{ name: string }> };
    assert.deepEqual(
      schemaJson.columns.map((c) => c.name),
      ['region', 'amount'],
    );

    const rows = await asUser('user-1', () =>
      tool.handle({
        query: 'query_rows',
        dataset_id: datasetId,
        filters: [{ column: 'region', op: 'eq', value: 'North' }],
      }),
    );
    const rowsJson = JSON.parse(rows) as { totalMatched: number };
    assert.equal(rowsJson.totalMatched, 1);
  });

  it('never leaks existence of another user\'s dataset', async () => {
    const graph = new InMemoryKnowledgeGraph();
    const { datasetId } = await graph.ingestDataset({
      ownerOmadiaUserId: 'user-1',
      name: 'Secret',
      sourceFileName: 's.csv',
      columns: [{ name: 'v', type: 'number' }],
      rows: [{ v: 1 }],
    });
    const tool = new QueryDatasetTool(graph);
    const out = await asUser('user-2', () =>
      tool.handle({ query: 'get_schema', dataset_id: datasetId }),
    );
    assert.deepEqual(JSON.parse(out), { error: 'not_found_or_not_owned' });
  });

  it('surfaces a validation error for an unknown column without throwing', async () => {
    const graph = new InMemoryKnowledgeGraph();
    const { datasetId } = await graph.ingestDataset({
      ownerOmadiaUserId: 'user-1',
      name: 'D',
      sourceFileName: 'd.csv',
      columns: [{ name: 'v', type: 'number' }],
      rows: [{ v: 1 }],
    });
    const tool = new QueryDatasetTool(graph);
    const out = await asUser('user-1', () =>
      tool.handle({
        query: 'query_rows',
        dataset_id: datasetId,
        filters: [{ column: 'nope', op: 'eq', value: 1 }],
      }),
    );
    assert.match(out, /Error:.*unknown_filter_column/);
  });
});
