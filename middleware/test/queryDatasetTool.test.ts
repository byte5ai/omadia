import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { InMemoryKnowledgeGraph } from '@omadia/knowledge-graph-inmemory';
import type { KnowledgeGraph } from '@omadia/plugin-api';

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
    // #568 widened the return to `{ omadiaUserId, authSubjectKey }` so the one
    // round-trip also carries the IdP subject the MCP token is keyed on. The
    // dataset-ACL half this test covers still reads only the canonical id.
    const { omadiaUserId: resolvedOmadiaUserId } = await resolveTurnOwnerIdentity(
      graph,
      { userId: rawChannelUserId, channelIdentity },
    );
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

  it('refuses a filter on a __k_ link-key column before touching the graph', async () => {
    const graph = new InMemoryKnowledgeGraph();
    const { datasetId } = await graph.ingestDataset({
      ownerOmadiaUserId: 'user-1',
      name: 'D',
      sourceFileName: 'd.csv',
      columns: [
        { name: 'Name', type: 'string' },
        { name: '__k_Name', type: 'string' },
      ],
      rows: [{ Name: 'Ada', __k_Name: 'a1b2c3d4e5f60001' }],
    });
    const tool = new QueryDatasetTool(graph);
    const out = await asUser('user-1', () =>
      tool.handle({
        query: 'query_rows',
        dataset_id: datasetId,
        filters: [{ column: '__k_Name', op: 'eq', value: 'a1b2c3d4e5f60001' }],
      }),
    );
    assert.match(out, /Error: link_key_filter/);
    // The key itself may be read — only filtering on it is refused.
    const rows = await asUser('user-1', () =>
      tool.handle({ query: 'query_rows', dataset_id: datasetId }),
    );
    assert.match(rows, /a1b2c3d4e5f60001/);
  });
});

/**
 * #1093 — `dataset_id` reaches the tool straight from the model, and on the
 * Neon backend it lands in `WHERE id = $2` against a `uuid` column: a
 * non-uuid id raises Postgres `22P02` BEFORE any owner check. The in-memory
 * graph these tests otherwise use returns `null` for an unknown id and can
 * therefore never reproduce that — hence the throwing fake below, and the
 * "never touched the graph" assertions.
 *
 * The id the model actually passes is a Privacy-Shield digest's
 * `ds_<uuid>` (a turn-scoped in-memory dataset), which is a DIFFERENT id
 * space from the uploaded datasets `query_dataset` reads — and one the
 * digest itself tells the model to carry to other tools (`create_xlsx`),
 * so "the model should know better" is not a fix.
 */
const PG_UUID_SYNTAX_ERROR = 'invalid input syntax for type uuid';

function throwingGraph(): {
  graph: KnowledgeGraph;
  calls: string[];
} {
  const calls: string[] = [];
  const graph = {
    getDataset: (datasetId: string): Promise<never> => {
      calls.push(`getDataset:${datasetId}`);
      return Promise.reject(new Error(`${PG_UUID_SYNTAX_ERROR}: "${datasetId}"`));
    },
    queryDatasetRows: (datasetId: string): Promise<never> => {
      calls.push(`queryDatasetRows:${datasetId}`);
      return Promise.reject(new Error(`${PG_UUID_SYNTAX_ERROR}: "${datasetId}"`));
    },
  } as unknown as KnowledgeGraph;
  return { graph, calls };
}

describe('QueryDatasetTool — dataset_id validation (#1093)', () => {
  const SHIELD_ID = 'ds_00000000-0000-0000-0000-000000000000';

  for (const query of ['get_schema', 'query_rows'] as const) {
    it(`rejects a Privacy-Shield ds_ id on ${query} without touching the graph`, async () => {
      const { graph, calls } = throwingGraph();
      const tool = new QueryDatasetTool(graph);
      const out = await asUser('user-1', () =>
        tool.handle({ query, dataset_id: SHIELD_ID }),
      );
      assert.match(out, /^Error: /);
      // The model must learn WHICH id space the id belongs to, or it
      // retries the same id on the next iteration.
      assert.match(out, /v4_/);
      assert.match(out, /list_datasets/);
      assert.doesNotMatch(out, new RegExp(PG_UUID_SYNTAX_ERROR));
      assert.deepEqual(calls, [], 'the graph must not be called for a non-uuid id');
    });

    it(`answers not_found_or_not_owned for any other non-uuid id on ${query}`, async () => {
      const { graph, calls } = throwingGraph();
      const tool = new QueryDatasetTool(graph);
      const out = await asUser('user-1', () =>
        tool.handle({ query, dataset_id: 'not-a-uuid' }),
      );
      // Same shape as a dataset owned by someone else — existence of an id
      // outside the caller's scope stays unobservable.
      assert.equal(out, JSON.stringify({ error: 'not_found_or_not_owned' }));
      assert.deepEqual(calls, [], 'the graph must not be called for a non-uuid id');
    });

    it(`returns a recoverable error instead of throwing when the graph rejects on ${query}`, async () => {
      // A well-formed uuid passes the guard, so this exercises the layer
      // below it: `get_schema` had no try/catch at all, and its rejection
      // left the tool handler and killed the whole streaming turn.
      const { graph, calls } = throwingGraph();
      const tool = new QueryDatasetTool(graph);
      const out = await asUser('user-1', () =>
        tool.handle({
          query,
          dataset_id: '11111111-2222-3333-4444-555555555555',
        }),
      );
      assert.match(out, /^Error: query_dataset failed/);
      assert.equal(calls.length, 1, 'a uuid id must reach the graph');
    });
  }

  it('still resolves a real dataset by its uuid id', async () => {
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
      tool.handle({ query: 'get_schema', dataset_id: datasetId }),
    );
    assert.match(out, /"rowCount":1/);
  });

  // Postgres accepts all of these as `uuid` input, so an id that resolved
  // before any validation existed must keep resolving — and must reach the
  // graph in ONE canonical spelling, whichever the model typed.
  for (const spelling of [
    '11111111-AAAA-4BBB-8CCC-555555555555',
    '11111111aaaa4bbb8ccc555555555555',
    '{11111111-aaaa-4bbb-8ccc-555555555555}',
    ' 11111111-aaaa-4bbb-8ccc-555555555555 ',
  ]) {
    it(`canonicalises the uuid spelling "${spelling}" before querying`, async () => {
      const { graph, calls } = throwingGraph();
      const tool = new QueryDatasetTool(graph);
      await asUser('user-1', () =>
        tool.handle({ query: 'get_schema', dataset_id: spelling }),
      );
      assert.deepEqual(calls, [
        'getDataset:11111111-aaaa-4bbb-8ccc-555555555555',
      ]);
    });
  }

  it('reports a list_datasets backend failure as a tool error, not a throw', async () => {
    const graph = {
      listDatasets: (): Promise<never> =>
        Promise.reject(new Error('connection terminated unexpectedly')),
    } as unknown as KnowledgeGraph;
    const tool = new QueryDatasetTool(graph);
    const out = await asUser('user-1', () => tool.handle({ query: 'list_datasets' }));
    assert.match(out, /^Error: query_dataset failed/);
    assert.match(out, /connection terminated/);
  });
});
