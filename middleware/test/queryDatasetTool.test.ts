import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { InMemoryKnowledgeGraph } from '@omadia/knowledge-graph-inmemory';

// Imported from the SAME relative source path `queryDatasetTool.ts` itself
// uses (not the built `@omadia/orchestrator` package) — tsx loads test files
// straight from source, so importing the compiled package here would create
// a SECOND module instance with its own AsyncLocalStorage, and turnContext
// set in the test would never be visible inside the tool.
import { turnContext } from '../packages/harness-orchestrator/src/turnContext.js';
import { resolveTurnOwnerIdentity } from '../packages/harness-orchestrator/src/resolveTurnOwnerIdentity.js';
import { QueryDatasetTool } from '../packages/harness-orchestrator/src/tools/queryDatasetTool.js';

// #430 fixup (reviewer round 5) — `QueryDatasetTool` now reads
// `resolvedOmadiaUserId`, not the raw `userId`. These existing tests treat
// the two as equal (HTTP/CLI-turn shape: no `channelIdentity`, so
// `resolvedOmadiaUserId` === `userId` by `resolveTurnOwnerIdentity`'s
// fallback rule) — see the dedicated channel-turn test below for the case
// where they diverge.
function asUser(userId: string, fn: () => Promise<string>): Promise<string> {
  return turnContext.run(
    { turnId: 't', turnDate: '2026-01-01', userId, resolvedOmadiaUserId: userId },
    fn,
  );
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

  // #430 fixup (reviewer round 5) — the bug this closes: a channel turn
  // (Teams/Slack/Telegram) imports a dataset under the CANONICAL
  // `omadiaUserId`, but `query_dataset` used to read the RAW channel-native
  // id from `turnContext.current()?.userId` — those never match, so the
  // exact user/channel that just imported a dataset could never find it
  // again. Uses the SAME production resolution helper
  // (`resolveTurnOwnerIdentity`) the orchestrator now calls once per turn,
  // and builds the turnContext the same shape a real channel turn gets
  // (`userId` = raw channel-native id, `resolvedOmadiaUserId` = the
  // resolved canonical uuid) — not a hand-picked value that would pass even
  // if the real wiring were broken. Imports directly via
  // `KnowledgeGraph.ingestDataset` (full CSV-attachment wiring is covered
  // by `orchestratorCsvDatasetIdentity.test.ts`) since `resolveOrCreate
  // ChannelIdentity` is documented idempotent — a real import turn through
  // `ingestAttachments` would resolve to the exact same `omadiaUserId`.
  it('finds a dataset imported by a channel turn when queried by the SAME channel turn', async () => {
    const graph = new InMemoryKnowledgeGraph();
    const rawChannelUserId = 'aad-oid-channel-1';
    const channelIdentity = { channelKind: 'teams' as const, channelUserId: rawChannelUserId };

    // What the orchestrator's per-turn resolution computes at turn start —
    // this is the identical call `runTurn`/`chatStream` make.
    const resolvedOmadiaUserId = await resolveTurnOwnerIdentity(graph, {
      userId: rawChannelUserId,
      channelIdentity,
    });
    assert.ok(resolvedOmadiaUserId, 'channel identity must resolve to a canonical id');
    assert.notEqual(
      resolvedOmadiaUserId,
      rawChannelUserId,
      'the resolved id must NOT be the raw channel-native id',
    );

    // The import path: writes ownership under the CANONICAL id (mirrors
    // `ingestAttachments` after the #430 fixup).
    const { datasetId } = await graph.ingestDataset({
      ownerOmadiaUserId: resolvedOmadiaUserId as string,
      name: 'Channel import',
      sourceFileName: 'data.csv',
      columns: [{ name: 'v', type: 'number' }],
      rows: [{ v: 1 }],
    });

    const tool = new QueryDatasetTool(graph);

    // The query path, from the SAME channel turn: turnContext carries both
    // the raw `userId` AND the resolved `resolvedOmadiaUserId`, exactly as
    // `runTurn`/`chatStream` now populate it.
    const listed = await turnContext.run(
      {
        turnId: 't-channel',
        turnDate: '2026-01-01',
        userId: rawChannelUserId,
        resolvedOmadiaUserId,
      },
      () => tool.handle({ query: 'list_datasets' }),
    );
    const listedJson = JSON.parse(listed) as { datasets: Array<{ id: string }> };
    assert.equal(
      listedJson.datasets.length,
      1,
      'the channel user must find the dataset THEY just imported',
    );
    assert.equal(listedJson.datasets[0]?.id, datasetId);

    const schema = await turnContext.run(
      {
        turnId: 't-channel',
        turnDate: '2026-01-01',
        userId: rawChannelUserId,
        resolvedOmadiaUserId,
      },
      () => tool.handle({ query: 'get_schema', dataset_id: datasetId }),
    );
    assert.notDeepEqual(JSON.parse(schema), { error: 'not_found_or_not_owned' });

    // Regression guard for the exact bug this closes: if the tool were
    // still reading the raw `userId` (pre-fixup behaviour), it would list
    // the dataset under the WRONG (raw) id. Prove ownership is keyed to the
    // canonical id only — the raw id owns nothing in the graph directly.
    const ownedByRawId = await graph.listDatasets({ ownerOmadiaUserId: rawChannelUserId });
    assert.equal(
      ownedByRawId.length,
      0,
      'the raw channel-native id must never itself own the dataset',
    );

    // And a turn that only has the raw id (no `resolvedOmadiaUserId` —
    // resolution failed/unavailable) is correctly treated as "no identity",
    // not silently allowed through with the wrong id.
    const noResolvedId = await turnContext.run(
      { turnId: 't-raw', turnDate: '2026-01-01', userId: rawChannelUserId },
      () => tool.handle({ query: 'list_datasets' }),
    );
    assert.match(noResolvedId, /Error:.*user identity/);
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
