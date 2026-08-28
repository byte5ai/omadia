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

// #430 — structured dataset ingestion.
describe('InMemoryKnowledgeGraph — datasets (#430)', () => {
  it('ingests a dataset, creates exactly one Dataset graph node, and is listable/gettable by owner', async () => {
    const g = new InMemoryKnowledgeGraph();
    const result = await g.ingestDataset({
      ownerOmadiaUserId: 'user-1',
      name: 'People',
      sourceFileName: 'people.csv',
      columns: [
        { name: 'name', type: 'string' },
        { name: 'age', type: 'number' },
      ],
      rows: [
        { name: 'Ada', age: 36 },
        { name: 'Grace', age: 85 },
      ],
    });
    assert.equal(result.rowCount, 2);

    const stats = await g.stats();
    assert.equal(stats.byNodeType.PluginEntity, 1);

    const listed = await g.listDatasets({ ownerOmadiaUserId: 'user-1' });
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.id, result.datasetId);

    const fetched = await g.getDataset(result.datasetId, 'user-1');
    assert.ok(fetched);
    assert.equal(fetched?.rowCount, 2);
  });

  it('pages listDatasets with offset and counts all owned datasets (#532)', async () => {
    const g = new InMemoryKnowledgeGraph();
    for (let i = 0; i < 5; i++) {
      await g.ingestDataset({
        ownerOmadiaUserId: 'user-1',
        name: `ds-${String(i)}`,
        sourceFileName: `ds-${String(i)}.csv`,
        columns: [{ name: 'v', type: 'number' }],
        rows: [{ v: i }],
      });
    }
    await g.ingestDataset({
      ownerOmadiaUserId: 'user-2',
      name: 'other',
      sourceFileName: 'other.csv',
      columns: [{ name: 'v', type: 'number' }],
      rows: [{ v: 0 }],
    });

    const firstPage = await g.listDatasets({ ownerOmadiaUserId: 'user-1', limit: 2 });
    assert.equal(firstPage.length, 2);
    const lastPage = await g.listDatasets({ ownerOmadiaUserId: 'user-1', limit: 2, offset: 4 });
    assert.equal(lastPage.length, 1);
    // Pages are disjoint slices of the same ordering.
    const all = await g.listDatasets({ ownerOmadiaUserId: 'user-1' });
    assert.deepEqual(
      [...firstPage, ...(await g.listDatasets({ ownerOmadiaUserId: 'user-1', limit: 2, offset: 2 })), ...lastPage].map((d) => d.id),
      all.map((d) => d.id),
    );

    assert.equal(await g.countDatasets({ ownerOmadiaUserId: 'user-1' }), 5);
    assert.equal(await g.countDatasets({ ownerOmadiaUserId: 'user-2' }), 1);
    assert.equal(await g.countDatasets({ ownerOmadiaUserId: 'nobody' }), 0);
  });

  it('hides a dataset from a non-owner (getDataset/listDatasets/queryDatasetRows all return null/empty)', async () => {
    const g = new InMemoryKnowledgeGraph();
    const result = await g.ingestDataset({
      ownerOmadiaUserId: 'user-1',
      name: 'Secret',
      sourceFileName: 's.csv',
      columns: [{ name: 'v', type: 'number' }],
      rows: [{ v: 1 }],
    });
    assert.equal(await g.getDataset(result.datasetId, 'user-2'), null);
    assert.deepEqual(await g.listDatasets({ ownerOmadiaUserId: 'user-2' }), []);
    assert.equal(await g.queryDatasetRows(result.datasetId, 'user-2'), null);
  });

  it('filters rows via the constrained DSL (eq / contains / numeric comparisons)', async () => {
    const g = new InMemoryKnowledgeGraph();
    const { datasetId } = await g.ingestDataset({
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
        { region: 'North', amount: 400 },
      ],
    });

    const north = await g.queryDatasetRows(datasetId, 'user-1', {
      filters: [{ column: 'region', op: 'eq', value: 'North' }],
    });
    assert.equal(north?.totalMatched, 2);
    assert.equal(north?.rows?.length, 2);

    const big = await g.queryDatasetRows(datasetId, 'user-1', {
      filters: [{ column: 'amount', op: 'gt', value: 200 }],
    });
    assert.equal(big?.totalMatched, 2);

    const contains = await g.queryDatasetRows(datasetId, 'user-1', {
      filters: [{ column: 'region', op: 'contains', value: 'orth' }],
    });
    assert.equal(contains?.totalMatched, 2);
  });

  // #430 review fixup — `matchesDatasetFilter`'s `eq`/`neq`/`contains` cases
  // must coerce `filter.value` to the column's declared type BEFORE
  // comparing, exactly like `buildDatasetFilterClause` does for the Neon
  // backend (`(data->>col)::numeric = $1::numeric` for a `number` column).
  // Without that coercion, a `number` column storing a JS `number` row value
  // silently failed to match a filter value that arrived as a JSON string
  // (the tool's Zod schema allows `string | number | boolean` regardless of
  // the target column's type or op) — the exact same logical query matched
  // on the Neon backend but returned `totalMatched: 0` here.
  it('coerces a string filter value against a number column for eq (backend parity, #430 fixup)', async () => {
    const g = new InMemoryKnowledgeGraph();
    const { datasetId } = await g.ingestDataset({
      ownerOmadiaUserId: 'user-1',
      name: 'Sales',
      sourceFileName: 'sales.csv',
      columns: [
        { name: 'region', type: 'string' },
        { name: 'amount', type: 'number' },
        { name: 'label', type: 'string' },
      ],
      rows: [
        { region: 'North', amount: 100, label: 'Order-100' },
        { region: 'South', amount: 250, label: 'Order-250' },
        { region: 'North', amount: 400, label: 'Order-400' },
      ],
    });

    // `amount` is a `number` column storing `250` as a JS number; the filter
    // value arrives as the string `'250'` — must still match.
    const eqCoerced = await g.queryDatasetRows(datasetId, 'user-1', {
      filters: [{ column: 'amount', op: 'eq', value: '250' }],
    });
    assert.equal(eqCoerced?.totalMatched, 1);
    assert.equal(eqCoerced?.rows?.[0]?.['region'], 'South');

    // Mirror case for `neq`: everything except the coerced match.
    const neqCoerced = await g.queryDatasetRows(datasetId, 'user-1', {
      filters: [{ column: 'amount', op: 'neq', value: '250' }],
    });
    assert.equal(neqCoerced?.totalMatched, 2);

    // Mirror case for `contains`: `filter.value` arrives as a number even
    // though the target column (`label`) is `string` — must be coerced to
    // a string before the substring check instead of being rejected
    // outright (the old code required `typeof filter.value === 'string'`).
    const containsCoerced = await g.queryDatasetRows(datasetId, 'user-1', {
      filters: [{ column: 'label', op: 'contains', value: 400 as unknown as string }],
    });
    assert.equal(containsCoerced?.totalMatched, 1);
    assert.equal(containsCoerced?.rows?.[0]?.['label'], 'Order-400');
  });

  it('clamps an explicit limit:0 to 1 row instead of silently falling back to the default (#430 fixup)', async () => {
    const g = new InMemoryKnowledgeGraph();
    const { datasetId } = await g.ingestDataset({
      ownerOmadiaUserId: 'user-1',
      name: 'Sales',
      sourceFileName: 'sales.csv',
      columns: [{ name: 'region', type: 'string' }],
      rows: [{ region: 'North' }, { region: 'South' }],
    });

    const zeroLimit = await g.queryDatasetRows(datasetId, 'user-1', { limit: 0 });
    assert.equal(zeroLimit?.rows?.length, 1, 'limit:0 must clamp to 1, not fall back to the default');
    assert.equal(zeroLimit?.totalMatched, 2);
  });

  it('aggregates with and without groupBy', async () => {
    const g = new InMemoryKnowledgeGraph();
    const { datasetId } = await g.ingestDataset({
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
        { region: 'North', amount: 400 },
      ],
    });

    const total = await g.queryDatasetRows(datasetId, 'user-1', {
      aggregate: { fn: 'sum', column: 'amount' },
    });
    assert.equal(total?.aggregateValue, 750);

    const byRegion = await g.queryDatasetRows(datasetId, 'user-1', {
      groupBy: 'region',
      aggregate: { fn: 'sum', column: 'amount' },
    });
    const asMap = new Map(byRegion?.groups?.map((gr) => [gr.key, gr.value]));
    assert.equal(asMap.get('North'), 500);
    assert.equal(asMap.get('South'), 250);

    const count = await g.queryDatasetRows(datasetId, 'user-1', {
      aggregate: { fn: 'count' },
    });
    assert.equal(count?.aggregateValue, 3);
  });

  it('#430 fixup — caps grouped results at 200, matching the Neon backend LIMIT, sorted by value descending', async () => {
    const g = new InMemoryKnowledgeGraph();
    const rows = Array.from({ length: 250 }, (_, i) => ({
      key: `k${String(i)}`,
      amount: i, // distinct value per group so the sort order is unambiguous
    }));
    const { datasetId } = await g.ingestDataset({
      ownerOmadiaUserId: 'user-1',
      name: 'ManyGroups',
      sourceFileName: 'many.csv',
      columns: [
        { name: 'key', type: 'string' },
        { name: 'amount', type: 'number' },
      ],
      rows,
    });

    const result = await g.queryDatasetRows(datasetId, 'user-1', {
      groupBy: 'key',
      aggregate: { fn: 'sum', column: 'amount' },
    });
    assert.equal(result?.groups?.length, 200, 'must cap at 200 groups even though 250 unique keys exist');
    // `totalMatched` still reflects every row, not just the returned groups.
    assert.equal(result?.totalMatched, 250);
    // Deterministic: sorted by value descending, so the 200 HIGHEST-amount
    // groups survive (k249..k50), not the first 200 inserted (k0..k199).
    const values = (result?.groups ?? []).map((gr) => gr.value);
    assert.deepEqual(values, [...values].sort((a, b) => (b ?? 0) - (a ?? 0)));
    assert.equal(result?.groups?.[0]?.key, 'k249');
    assert.equal(
      result?.groups?.some((gr) => gr.key === 'k0'),
      false,
      'the lowest-value group must be truncated away, not the last-inserted one',
    );
  });

  it('rejects an unknown filter column and an aggregate on a non-number column', async () => {
    const g = new InMemoryKnowledgeGraph();
    const { datasetId } = await g.ingestDataset({
      ownerOmadiaUserId: 'user-1',
      name: 'D',
      sourceFileName: 'd.csv',
      columns: [{ name: 'name', type: 'string' }],
      rows: [{ name: 'Ada' }],
    });
    await assert.rejects(
      g.queryDatasetRows(datasetId, 'user-1', {
        filters: [{ column: 'nope', op: 'eq', value: 1 }],
      }),
    );
    await assert.rejects(
      g.queryDatasetRows(datasetId, 'user-1', {
        aggregate: { fn: 'sum', column: 'name' },
      }),
    );
  });

  it('deletes a dataset (owner-only) and drops its graph node', async () => {
    const g = new InMemoryKnowledgeGraph();
    const { datasetId } = await g.ingestDataset({
      ownerOmadiaUserId: 'user-1',
      name: 'D',
      sourceFileName: 'd.csv',
      columns: [{ name: 'v', type: 'number' }],
      rows: [{ v: 1 }],
    });
    assert.equal(
      await g.deleteDataset(datasetId, { actorOmadiaUserId: 'user-2' }),
      false,
      'non-owner delete is a no-op',
    );
    assert.equal(await g.deleteDataset(datasetId, { actorOmadiaUserId: 'user-1' }), true);
    assert.equal(await g.getDataset(datasetId, 'user-1'), null);
    const stats = await g.stats();
    assert.equal(stats.byNodeType.PluginEntity ?? 0, 0);
  });
});
