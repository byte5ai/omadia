import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { InMemoryKnowledgeGraph } from '@omadia/knowledge-graph-inmemory';
import {
  DatasetQueryValidationError,
  datasetDateTime,
  validateDatasetQueryOptions,
  type DatasetColumnSchema,
} from '@omadia/plugin-api';

// Same relative source paths `queryDatasetTool.ts` uses (see
// queryDatasetTool.test.ts: one module instance of turnContext).
import { turnContext } from '../packages/harness-orchestrator/src/turnContext.js';
import { QueryDatasetTool } from '../packages/harness-orchestrator/src/tools/queryDatasetTool.js';
import { normaliseDateFilterValue } from '../packages/harness-orchestrator/src/datasetDates.js';

/**
 * #2302 (ADR-0267) — `query_rows` range filters (gt/gte/lt/lte) on `date`
 * columns: compared as dates, bound parsed by the import's date parser, an
 * unreadable bound is a coded error, encrypted date columns stay refused.
 */

const OWNER = 'user-1';

function asUser(fn: () => Promise<string>): Promise<string> {
  return turnContext.run(
    { turnId: 't', turnDate: '2026-11-27', userId: OWNER, resolvedOmadiaUserId: OWNER },
    fn,
  );
}

const COLUMNS: DatasetColumnSchema[] = [
  { name: 'name', type: 'string' },
  { name: 'amount', type: 'number' },
  { name: 'due', type: 'date' },
];

async function seededGraph(): Promise<{ graph: InMemoryKnowledgeGraph; datasetId: string }> {
  const graph = new InMemoryKnowledgeGraph();
  const { datasetId } = await graph.ingestDataset({
    ownerOmadiaUserId: OWNER,
    name: 'Invoices',
    sourceFileName: 'invoices.csv',
    columns: COLUMNS,
    rows: [
      { name: 'a', amount: 1, due: '2024-03-31' },
      { name: 'b', amount: 2, due: '2024-04-19' },
      { name: 'c', amount: 3, due: '2024-04-19T10:30:00Z' },
      // Text order would put this after 2024-04-19T…; date order does not.
      { name: 'd', amount: 4, due: '2024-04-30T23:59' },
      { name: 'e', amount: 5, due: '2024-12-01' },
      // A cell from before #1845 (raw spelling) never matches a range.
      { name: 'f', amount: 6, due: '19.04.2024' },
      { name: 'g', amount: 7, due: null },
    ],
  });
  return { graph, datasetId };
}

describe('datasetDateTime (#2302)', () => {
  it('reads stored ISO dates and datetimes as wall-clock milliseconds', () => {
    assert.equal(datasetDateTime('2024-04-19'), Date.UTC(2024, 3, 19));
    assert.equal(datasetDateTime('2024-04-19T10:30'), Date.UTC(2024, 3, 19, 10, 30));
    assert.equal(datasetDateTime('2024-04-19T10:30:00Z'), Date.UTC(2024, 3, 19, 10, 30));
    assert.equal(datasetDateTime('2024-04-19T10:30:00.250Z'), Date.UTC(2024, 3, 19, 10, 30, 0, 250));
  });

  it('refuses non-ISO spellings, offsets, impossible dates and non-strings', () => {
    for (const v of ['19.04.2024', '2024-04-19T10:30+02:00', '2024-02-30', '2024-4-19', 'soon', 20240419, true]) {
      assert.equal(datasetDateTime(v), undefined, String(v));
    }
  });
});

describe('validateDatasetQueryOptions — date ranges (#2302)', () => {
  it('accepts gt/gte/lt/lte with an ISO bound on a date column', () => {
    for (const op of ['gt', 'gte', 'lt', 'lte'] as const) {
      const q = validateDatasetQueryOptions(COLUMNS, {
        filters: [{ column: 'due', op, value: '2024-04-19' }],
      });
      assert.equal(q.filters.length, 1);
    }
  });

  it('refuses an unreadable bound with invalid_date_value', () => {
    for (const value of ['next week', '19.04.2024', 20240419]) {
      assert.throws(
        () => validateDatasetQueryOptions(COLUMNS, { filters: [{ column: 'due', op: 'gte', value }] }),
        (err: unknown) => err instanceof DatasetQueryValidationError && err.code === 'invalid_date_value',
      );
    }
  });

  it('still refuses ranges on string columns', () => {
    assert.throws(
      () => validateDatasetQueryOptions(COLUMNS, { filters: [{ column: 'name', op: 'gt', value: 'a' }] }),
      (err: unknown) => err instanceof DatasetQueryValidationError && err.code === 'op_type_mismatch',
    );
  });
});

describe('InMemoryKnowledgeGraph — date range filters (#2302)', () => {
  async function names(filters: Parameters<InMemoryKnowledgeGraph['queryDatasetRows']>[2]): Promise<string[]> {
    const { graph, datasetId } = await seededGraph();
    const result = await graph.queryDatasetRows(datasetId, OWNER, filters);
    return (result?.rows ?? []).map((r) => String(r['name']));
  }

  it('compares as dates: a date-only bound is its midnight', async () => {
    assert.deepEqual(await names({ filters: [{ column: 'due', op: 'gte', value: '2024-04-19' }] }), ['b', 'c', 'd', 'e']);
    assert.deepEqual(await names({ filters: [{ column: 'due', op: 'gt', value: '2024-04-19' }] }), ['c', 'd', 'e']);
    assert.deepEqual(await names({ filters: [{ column: 'due', op: 'lte', value: '2024-04-19' }] }), ['a', 'b']);
    assert.deepEqual(await names({ filters: [{ column: 'due', op: 'lt', value: '2024-05-01' }] }), ['a', 'b', 'c', 'd']);
  });

  it('combines two bounds into a range and aggregates over it', async () => {
    const { graph, datasetId } = await seededGraph();
    const result = await graph.queryDatasetRows(datasetId, OWNER, {
      filters: [
        { column: 'due', op: 'gte', value: '2024-04-01' },
        { column: 'due', op: 'lt', value: '2024-05-01' },
      ],
      aggregate: { fn: 'sum', column: 'amount' },
    });
    assert.equal(result?.totalMatched, 3);
    assert.equal(result?.aggregateValue, 9);
  });

  it('keeps refusing every filter on a date column holding encrypted cells', async () => {
    const graph = new InMemoryKnowledgeGraph();
    const { datasetId } = await graph.ingestDataset({
      ownerOmadiaUserId: OWNER,
      name: 'People',
      sourceFileName: 'people.csv',
      columns: [{ name: 'birthday', type: 'date' }],
      rows: [{ birthday: 'enc1:AAAA' }, { birthday: '1990-01-01' }],
    });
    await assert.rejects(
      graph.queryDatasetRows(datasetId, OWNER, {
        filters: [{ column: 'birthday', op: 'lt', value: '1995-01-01' }],
      }),
      (err: unknown) => err instanceof DatasetQueryValidationError && err.code === 'encrypted_column',
    );
  });
});

describe('normaliseDateFilterValue (#2302)', () => {
  it('reads the import formats into stored ISO', () => {
    assert.equal(normaliseDateFilterValue('2024-04-19'), '2024-04-19');
    assert.equal(normaliseDateFilterValue('19.04.2024'), '2024-04-19');
    assert.equal(normaliseDateFilterValue('04/05/2024'), '2024-05-04', 'slash dates are day-first');
    assert.equal(normaliseDateFilterValue('04/19/2024'), '2024-04-19', 'month-first when only that fits');
    assert.equal(normaliseDateFilterValue('2024-04-19T12:00+02:00'), '2024-04-19T10:00:00Z');
    assert.equal(normaliseDateFilterValue('19.04.2024 08:15'), '2024-04-19T08:15');
  });

  it('returns undefined for a non-date', () => {
    for (const v of ['250', 'next week', '31.02.2024']) assert.equal(normaliseDateFilterValue(v), undefined, v);
  });
});

describe('QueryDatasetTool — date range filters (#2302)', () => {
  it('parses a German date bound and returns only the rows in range', async () => {
    const { graph, datasetId } = await seededGraph();
    const tool = new QueryDatasetTool(graph);
    const out = await asUser(() =>
      tool.handle({
        query: 'query_rows',
        dataset_id: datasetId,
        filters: [
          { column: 'due', op: 'gte', value: '01.04.2024' },
          { column: 'due', op: 'lte', value: '30.04.2024' },
        ],
      }),
    );
    const json = JSON.parse(out) as { totalMatched: number; rows: Array<{ name: string }> };
    assert.equal(json.totalMatched, 2);
    assert.deepEqual(json.rows.map((r) => r.name), ['b', 'c']);
  });

  it('answers an unreadable bound with a tool error naming the accepted formats', async () => {
    const { graph, datasetId } = await seededGraph();
    const tool = new QueryDatasetTool(graph);
    const out = await asUser(() =>
      tool.handle({
        query: 'query_rows',
        dataset_id: datasetId,
        filters: [{ column: 'due', op: 'gt', value: 'last spring' }],
      }),
    );
    assert.match(out, /^Error: invalid_date_value — /);
    assert.match(out, /Accepted date formats: ISO `yyyy-mm-dd`.*`d\.m\.yyyy`/);
    assert.doesNotMatch(out, /last spring/, 'the error does not echo the bound');
  });

  it('leaves number range filters untouched', async () => {
    const { graph, datasetId } = await seededGraph();
    const tool = new QueryDatasetTool(graph);
    const out = await asUser(() =>
      tool.handle({
        query: 'query_rows',
        dataset_id: datasetId,
        filters: [{ column: 'amount', op: 'gt', value: '5' }],
      }),
    );
    assert.equal((JSON.parse(out) as { totalMatched: number }).totalMatched, 2);
  });
});
