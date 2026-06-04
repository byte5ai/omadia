/**
 * Privacy Shield v4 — US1 Dataset Store tests.
 *
 * Covers `parseToolResult` (shape normalization + intern-time bound) and the
 * turn-scoped `createDatasetStore` (intern / get / put / finalizeTurn /
 * internedCount). The classifier and digest builder are stubbed — US2 and
 * US3 test those independently.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  createDatasetStore,
  parseToolResult,
} from '@omadia/plugin-privacy-guard/dist/v4/datasetStore.js';
import type {
  Classifier,
  Dataset,
  Digest,
} from '@omadia/plugin-privacy-guard/dist/v4/types.js';

// --- stubs -----------------------------------------------------------------

const stubClassify: Classifier = (rows, shape) => ({
  fields: [],
  rowCount: rows.length,
  shape,
});

const stubBuildDigest = (d: Dataset): Digest => ({
  datasetId: d.datasetId,
  rowCount: d.schema.rowCount,
  truncated: d.provenance.truncated,
  fields: [],
});

function newStore(maxInternChars?: number) {
  return createDatasetStore({
    classify: stubClassify,
    buildDigest: stubBuildDigest,
    turnId: 'turn-test',
    ...(maxInternChars !== undefined ? { maxInternChars } : {}),
  });
}

const HR_LEAVE = [
  { employee: 'Marvin Vomberg', days: 24 },
  { employee: 'Anna Rüsche', days: 30 },
  { employee: 'Thomas Görres', days: 18 },
];

// --- parseToolResult -------------------------------------------------------

describe('parseToolResult', () => {
  it('normalizes an array of objects to shape "rows"', () => {
    const r = parseToolResult(HR_LEAVE, 100_000);
    assert.equal(r.shape, 'rows');
    assert.equal(r.rows.length, 3);
    assert.equal(r.truncated, false);
  });

  it('parses a JSON-string tool result', () => {
    const r = parseToolResult(JSON.stringify(HR_LEAVE), 100_000);
    assert.equal(r.shape, 'rows');
    assert.equal(r.rows.length, 3);
  });

  it('interns non-JSON free text as a single scalar row', () => {
    const r = parseToolResult('the employee is on leave', 100_000);
    assert.equal(r.shape, 'scalar');
    assert.equal(r.rows.length, 1);
    assert.equal(r.rows[0]?.value, 'the employee is on leave');
  });

  it('treats a single object as shape "object"', () => {
    const r = parseToolResult({ employee: 'Marvin Vomberg', days: 24 }, 100_000);
    assert.equal(r.shape, 'object');
    assert.equal(r.rows.length, 1);
  });

  it('treats an object with a nested object value as shape "nested"', () => {
    // A nested *object* (not a record-array) is not a summary+detail wrapper,
    // so it stays a single nested row.
    const r = parseToolResult({ employee: 'X', meta: { y: 1 } }, 100_000);
    assert.equal(r.shape, 'nested');
    assert.equal(r.rows.length, 1);
  });

  it('promotes a "summary + detail" wrapper to the detail rows', () => {
    // A single object wrapping exactly one array-of-records is the common
    // "summary + detail" shape (e.g. a timesheet result). The detail array
    // becomes the dataset rows so each record is classified + rendered
    // individually instead of dumped as one masked JSON blob.
    const r = parseToolResult(
      {
        jahr: 2026,
        kw: 22,
        abweichungen_pro_ma: [
          { employee: 'Alexandra Hochhaus', delta_hours: -40 },
          { employee: 'Christian Köhler', delta_hours: -39.87 },
        ],
      },
      100_000,
    );
    assert.equal(r.shape, 'rows');
    assert.equal(r.rows.length, 2);
    // Detail fields are present...
    assert.equal(r.rows[0]?.employee, 'Alexandra Hochhaus');
    assert.equal(r.rows[0]?.delta_hours, -40);
    // ...and the scalar summary fields are broadcast onto every row.
    assert.equal(r.rows[0]?.jahr, 2026);
    assert.equal(r.rows[1]?.kw, 22);
    // The detail array key itself is never broadcast as a column.
    assert.equal('abweichungen_pro_ma' in (r.rows[0] ?? {}), false);
  });

  it('leaves an object with two record-arrays untouched (ambiguous)', () => {
    // More than one array-of-records is ambiguous — which is the detail
    // table? — so the object is kept as a single nested row.
    const r = parseToolResult({ a: [{ x: 1 }], b: [{ y: 2 }] }, 100_000);
    assert.equal(r.shape, 'nested');
    assert.equal(r.rows.length, 1);
  });

  it('a record in the detail wins a key collision over the summary', () => {
    const r = parseToolResult(
      { name: 'Report', rows: [{ name: 'Anna', n: 1 }] },
      100_000,
    );
    assert.equal(r.rows.length, 1);
    // The detail record's own `name` is kept, not the summary's "Report".
    assert.equal(r.rows[0]?.name, 'Anna');
  });

  it('interns an empty array as zero rows', () => {
    const r = parseToolResult([], 100_000);
    assert.equal(r.shape, 'rows');
    assert.equal(r.rows.length, 0);
    assert.equal(r.truncated, false);
  });

  it('wraps an array of scalars under a "value" column', () => {
    const r = parseToolResult([1, 2, 3], 100_000);
    assert.equal(r.shape, 'rows');
    assert.equal(r.rows.length, 3);
    assert.equal(r.rows[0]?.value, 1);
  });

  it('truncates to whole rows when over the intern bound', () => {
    const r = parseToolResult(HR_LEAVE, 60);
    assert.equal(r.truncated, true);
    assert.ok(r.rows.length >= 1 && r.rows.length < 3);
  });

  it('truncates oversized free text to the bound', () => {
    const big = 'x'.repeat(500);
    const r = parseToolResult(big, 100);
    assert.equal(r.truncated, true);
    assert.equal(r.rows[0]?.value, 'x'.repeat(100));
  });
});

// --- createDatasetStore ----------------------------------------------------

describe('createDatasetStore', () => {
  it('interns a tool result and returns an opaque datasetId + digest', () => {
    const store = newStore();
    const { datasetId, digest } = store.internToolResult('hr.leave', HR_LEAVE);
    assert.ok(datasetId.startsWith('ds_'));
    assert.equal(digest.datasetId, datasetId);
    assert.equal(digest.rowCount, 3);
  });

  it('holds the real rows server-side, retrievable by datasetId', () => {
    const store = newStore();
    const { datasetId } = store.internToolResult('hr.leave', HR_LEAVE);
    const ds = store.get(datasetId);
    assert.ok(ds);
    assert.equal(ds.rows.length, 3);
    assert.equal(ds.rows[0]?.employee, 'Marvin Vomberg');
    assert.equal(ds.provenance.toolName, 'hr.leave');
    assert.equal(ds.provenance.turnId, 'turn-test');
  });

  it('returns undefined for an unknown datasetId', () => {
    assert.equal(newStore().get('ds_nope'), undefined);
  });

  it('drops every dataset at finalizeTurn', () => {
    const store = newStore();
    const { datasetId } = store.internToolResult('hr.leave', HR_LEAVE);
    assert.ok(store.get(datasetId));
    store.finalizeTurn();
    assert.equal(store.get(datasetId), undefined);
  });

  it('surfaces truncation on the digest', () => {
    const store = newStore(60);
    const { digest } = store.internToolResult('hr.leave', HR_LEAVE);
    assert.equal(digest.truncated, true);
  });

  it('registers a verb-style dataset via put', () => {
    const store = newStore();
    const dataset: Dataset = {
      datasetId: 'ds_verb_1',
      rows: [{ employee: 'Anna Rüsche', days: 30 }],
      schema: { fields: [], rowCount: 1, shape: 'rows' },
      provenance: {
        toolName: 'sort',
        turnId: 'turn-test',
        derivedFrom: 'ds_source',
        truncated: false,
        createdAt: new Date().toISOString(),
      },
    };
    const { datasetId } = store.put(dataset);
    assert.equal(datasetId, 'ds_verb_1');
    assert.equal(store.get('ds_verb_1')?.rows.length, 1);
  });

  it('counts interned tool results but not verb puts', () => {
    const store = newStore();
    store.internToolResult('hr.leave', HR_LEAVE);
    store.internToolResult('hr.leave', HR_LEAVE);
    store.put({
      datasetId: 'ds_verb_2',
      rows: [],
      schema: { fields: [], rowCount: 0, shape: 'rows' },
      provenance: {
        toolName: 'filter',
        turnId: 'turn-test',
        truncated: false,
        createdAt: new Date().toISOString(),
      },
    });
    assert.equal(store.internedCount, 2);
  });
});
