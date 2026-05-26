/**
 * Privacy Shield v4 — US5 Verb API tests.
 *
 * Each verb runs server-side on real rows; the LLM only ever composes them.
 * Includes the SC-007 correctness check: a sort/aggregate chain equals a
 * trusted reference computation over the raw dataset.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { createDatasetStore } from '@omadia/plugin-privacy-guard/dist/v4/datasetStore.js';
import { createShapeClassifier } from '@omadia/plugin-privacy-guard/dist/v4/shapeClassifier.js';
import { buildDigest } from '@omadia/plugin-privacy-guard/dist/v4/digest.js';
import {
  VerbError,
  createVerbEngine,
} from '@omadia/plugin-privacy-guard/dist/v4/verbs/index.js';
import type { DatasetRow } from '@omadia/plugin-privacy-guard/dist/v4/types.js';

const EMPLOYEES = [
  { employee: 'Marvin Vomberg', employee_id: '4471', department: 'Engineering' },
  { employee: 'Anna Rüsche', employee_id: '5582', department: 'Sales' },
  { employee: 'Thomas Görres', employee_id: '6693', department: 'Engineering' },
  { employee: 'Lena Bauer', employee_id: '7704', department: 'Sales' },
];

// 24 leave records — 6 per employee; employee at index e books `e + 1` days
// per record, so per-employee totals are 6, 12, 18, 24.
const RECORDS: DatasetRow[] = [];
for (let i = 0; i < 24; i++) {
  const e = i % 4;
  const emp = EMPLOYEES[e]!;
  RECORDS.push({
    employee: emp.employee,
    employee_id: emp.employee_id,
    department: emp.department,
    days: e + 1,
  });
}

function harness() {
  const classify = createShapeClassifier();
  const store = createDatasetStore({ classify, buildDigest, turnId: 'turn-test' });
  const engine = createVerbEngine({ store, classify });
  const { datasetId: src } = store.internToolResult('hr.leave', RECORDS);
  return { store, engine, src };
}

describe('Verb API — single verbs', () => {
  it('count returns one row with the row count', () => {
    const { store, engine, src } = harness();
    const r = engine.count(src);
    assert.equal(store.get(r.datasetId)?.rows[0]?.count, 24);
  });

  it('filter keeps only matching rows', () => {
    const { store, engine, src } = harness();
    const r = engine.filter(src, { op: 'gte', field: 'days', value: 3 });
    // employees at index 2 and 3 (days 3 and 4) → 12 records
    assert.equal(store.get(r.datasetId)?.rows.length, 12);
  });

  it('select projects to the requested columns', () => {
    const { store, engine, src } = harness();
    const r = engine.select(src, ['employee_id', 'days']);
    const row = store.get(r.datasetId)?.rows[0];
    assert.deepEqual(Object.keys(row ?? {}).sort(), ['days', 'employee_id']);
  });

  it('group returns the distinct safe-field combinations', () => {
    const { store, engine, src } = harness();
    const r = engine.group(src, ['department']);
    assert.equal(store.get(r.datasetId)?.rows.length, 2);
  });

  it('aggregate without groupBy reduces the whole dataset', () => {
    const { store, engine, src } = harness();
    const r = engine.aggregate(src, {
      ops: [{ alias: 'total_days', fn: 'sum', field: 'days' }],
    });
    const rows = store.get(r.datasetId)?.rows ?? [];
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.total_days, 6 * (1 + 2 + 3 + 4)); // 60
  });

  it('aggregate with groupBy produces one row per group', () => {
    const { store, engine, src } = harness();
    const r = engine.aggregate(src, {
      groupBy: ['employee_id'],
      ops: [{ alias: 'total', fn: 'sum', field: 'days' }],
    });
    assert.equal(store.get(r.datasetId)?.rows.length, 4);
  });

  it('join merges two datasets on a safe key', () => {
    const { store, engine, src } = harness();
    const empDs = store.internToolResult('employees', EMPLOYEES).datasetId;
    const totals = engine.aggregate(src, {
      groupBy: ['employee_id'],
      ops: [{ alias: 'total', fn: 'sum', field: 'days' }],
    });
    const joined = engine.join(totals.datasetId, empDs, {
      left: 'employee_id',
      right: 'employee_id',
    });
    const rows = store.get(joined.datasetId)?.rows ?? [];
    assert.equal(rows.length, 4);
    assert.ok('total' in (rows[0] ?? {}) && 'department' in (rows[0] ?? {}));
  });
});

describe('Verb API — composition & correctness (SC-007)', () => {
  it('aggregate → sort → top_n equals a trusted reference ranking', () => {
    const { store, engine, src } = harness();

    // Trusted reference: per-employee leave totals computed over raw rows.
    const ref = new Map<string, number>();
    for (const r of RECORDS) {
      const id = String(r.employee_id);
      ref.set(id, (ref.get(id) ?? 0) + Number(r.days));
    }
    const refRanked = [...ref.entries()].sort((a, b) => b[1] - a[1]);

    const totals = engine.aggregate(src, {
      groupBy: ['employee_id'],
      ops: [{ alias: 'total', fn: 'sum', field: 'days' }],
    });
    const sorted = engine.sort(totals.datasetId, 'total', 'desc');
    const top = engine.topN(sorted.datasetId, 1, 'total', 'desc');

    const winner = store.get(top.datasetId)?.rows[0];
    assert.equal(winner?.employee_id, refRanked[0]?.[0]);
    assert.equal(winner?.total, refRanked[0]?.[1]);

    // The full sorted order matches the reference too — no dupes, no invented.
    const sortedRows = store.get(sorted.datasetId)?.rows ?? [];
    assert.deepEqual(
      sortedRows.map((r) => [String(r.employee_id), Number(r.total)]),
      refRanked,
    );
  });
});

describe('Verb API — guard rails', () => {
  it('rejects a predicate over a masked field', () => {
    const { engine, src } = harness();
    assert.throws(
      () => engine.filter(src, { op: 'eq', field: 'employee', value: 'x' }),
      VerbError,
    );
  });

  it('rejects grouping on a masked field', () => {
    const { engine, src } = harness();
    assert.throws(() => engine.group(src, ['employee']), VerbError);
  });

  it('rejects an aggregate over a non-numeric field', () => {
    const { engine, src } = harness();
    assert.throws(
      () =>
        engine.aggregate(src, {
          ops: [{ alias: 'x', fn: 'sum', field: 'department' }],
        }),
      VerbError,
    );
  });

  it('rejects an unknown datasetId', () => {
    const { engine } = harness();
    assert.throws(() => engine.count('ds_does_not_exist'), VerbError);
  });
});
