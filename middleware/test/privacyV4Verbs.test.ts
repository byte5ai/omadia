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
  normalizeKeyPart,
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

// ---------------------------------------------------------------------------
// union / distinct — the cross-file dedup building blocks
// ---------------------------------------------------------------------------

/** Two "uploads" of a contact list. `__k_email` stands in for the import-time
 *  link key: an opaque, digit-bearing token that is identical for the same
 *  person in both files even though the e-mail text is masked. */
const FILE_A: DatasetRow[] = [
  { email: '[masked]', __k_email: 'a1f9c2e4b7d80013', firma: 'byte5', src: 'A' },
  { email: '[masked]', __k_email: 'b2e8d3f5c6a90124', firma: 'Fraunhofer', src: 'A' },
  { email: '', __k_email: null, firma: 'unbekannt', src: 'A' },
];
const FILE_B: DatasetRow[] = [
  { email: '[masked]', __k_email: 'a1f9c2e4b7d80013', firma: 'byte5 GmbH', src: 'B' },
  { email: '[masked]', __k_email: 'c3d7e4a6b5f80235', firma: 'omadia', src: 'B' },
  { email: '', __k_email: null, firma: 'unbekannt', src: 'B' },
];

function twoFiles() {
  const classify = createShapeClassifier();
  const store = createDatasetStore({ classify, buildDigest, turnId: 'turn-test' });
  const engine = createVerbEngine({ store, classify });
  const { datasetId: a } = store.internToolResult('query_dataset', FILE_A);
  const { datasetId: b } = store.internToolResult('query_dataset', FILE_B);
  return { store, engine, a, b };
}

describe('Verb API — union', () => {
  it('concatenates both datasets, left rows first', () => {
    const { store, engine, a, b } = twoFiles();
    const r = engine.union(a, b);
    const rows = store.get(r.datasetId)!.rows;
    assert.equal(rows.length, 6);
    assert.deepEqual(rows.map((x) => x.src), ['A', 'A', 'A', 'B', 'B', 'B']);
  });

  it('applies renameRight so differently-spelled headers land in one column', () => {
    const { store, engine, a } = twoFiles();
    const { datasetId: other } = store.internToolResult('query_dataset', [
      { Company: 'acme', __k_Company: 'd4e5f6a7b8c90346' },
    ]);
    const r = engine.union(a, other, {
      renameRight: { Company: 'firma', __k_Company: '__k_firma' },
    });
    const last = store.get(r.datasetId)!.rows.at(-1)!;
    assert.equal(last.firma, 'acme');
    assert.equal(last.__k_firma, 'd4e5f6a7b8c90346');
    assert.equal('Company' in last, false);
  });

  it('rejects a rename of an unknown right field', () => {
    const { engine, a, b } = twoFiles();
    assert.throws(
      () => engine.union(a, b, { renameRight: { nope: 'firma' } }),
      VerbError,
    );
  });

  it('rejects two right fields renamed to the same target', () => {
    const { engine, a, b } = twoFiles();
    assert.throws(
      () => engine.union(a, b, { renameRight: { email: 'x', firma: 'x' } }),
      VerbError,
    );
  });

  it('rejects a rename target that collides with a right field not itself renamed', () => {
    const { engine, a, b } = twoFiles();
    assert.throws(
      () => engine.union(a, b, { renameRight: { email: 'firma' } }),
      VerbError,
    );
  });

  it('allows a swap: both colliding fields are renamed', () => {
    const { store, engine, a, b } = twoFiles();
    const r = engine.union(a, b, { renameRight: { email: 'firma', firma: 'email' } });
    const last = store.get(r.datasetId)!.rows.at(-1)!;
    assert.equal(last.email, 'unbekannt');
    assert.equal(last.firma, '');
  });

  it('returns a new datasetId derived from the left input', () => {
    const { store, engine, a, b } = twoFiles();
    const r = engine.union(a, b);
    assert.notEqual(r.datasetId, a);
    assert.equal(store.get(r.datasetId)!.provenance.derivedFrom, a);
    assert.equal(store.get(r.datasetId)!.provenance.toolName, 'union');
  });
});

describe('Verb API — distinct', () => {
  it('a link-key column is classified safe and accepted as a key', () => {
    const { store, a } = twoFiles();
    const f = store.get(a)!.schema.fields.find((x) => x.path === '__k_email')!;
    assert.equal(f.classification, 'safe-cleartext');
  });

  it('collapses rows with the same key across two unioned files', () => {
    const { store, engine, a, b } = twoFiles();
    const u = engine.union(a, b);
    const d = engine.distinct(u.datasetId, ['__k_email']);
    const rows = store.get(d.datasetId)!.rows;
    // 6 rows in, one shared key (the byte5 contact) → 5 out; both
    // null-key rows are kept.
    assert.equal(rows.length, 5);
    assert.equal(d.digest.rowCount, 5);
    const byte5 = rows.filter((r) => r.__k_email === 'a1f9c2e4b7d80013');
    assert.equal(byte5.length, 1);
    assert.equal(byte5[0]!.src, 'A', 'keep: first keeps the earlier row');
  });

  it('keep: "last" keeps the later row and preserves dataset order', () => {
    const { store, engine, a, b } = twoFiles();
    const u = engine.union(a, b);
    const d = engine.distinct(u.datasetId, ['__k_email'], 'last');
    const rows = store.get(d.datasetId)!.rows;
    assert.equal(rows.length, 5);
    const byte5 = rows.find((r) => r.__k_email === 'a1f9c2e4b7d80013')!;
    assert.equal(byte5.src, 'B');
    assert.equal(byte5.firma, 'byte5 GmbH');
    // Original order, not reversed.
    assert.deepEqual(rows.map((r) => r.src), ['A', 'A', 'B', 'B', 'B']);
  });

  it('never treats two empty keys as duplicates of each other', () => {
    const { store, engine, a, b } = twoFiles();
    const u = engine.union(a, b);
    const d = engine.distinct(u.datasetId, ['__k_email']);
    const nulls = store.get(d.datasetId)!.rows.filter((r) => r.__k_email === null);
    assert.equal(nulls.length, 2);
  });

  it('compares string keys case-insensitively', () => {
    const classify = createShapeClassifier();
    const store = createDatasetStore({ classify, buildDigest, turnId: 'turn-test' });
    const engine = createVerbEngine({ store, classify });
    // `status` is a low-cardinality single-token enum (3 distinct / 30 rows
    // = the S4 ratio ceiling) → safe → allowed as a key.
    const { datasetId } = store.internToolResult('x', [
      ...Array.from({ length: 28 }, () => ({ status: 'open' })),
      { status: 'OPEN' },
      { status: 'Open' },
    ]);
    const d = engine.distinct(datasetId, ['status']);
    assert.equal(store.get(d.datasetId)!.rows.length, 1);
  });

  it('normalizeKeyPart folds case, whitespace and NFKC; empty → null', () => {
    assert.equal(normalizeKeyPart(' Max  Mustermann '), normalizeKeyPart('max mustermann'));
    assert.equal(normalizeKeyPart('Ａnna'), normalizeKeyPart('anna'));
    assert.equal(normalizeKeyPart(''), null);
    assert.equal(normalizeKeyPart('   '), null);
    assert.equal(normalizeKeyPart(null), null);
    assert.equal(normalizeKeyPart(undefined), null);
    assert.notEqual(normalizeKeyPart(1), normalizeKeyPart('1'), 'a number is not its string');
  });

  it('rejects a masked field as key and an empty `by`', () => {
    const { engine, a } = twoFiles();
    assert.throws(() => engine.distinct(a, ['firma']), VerbError);
    assert.throws(() => engine.distinct(a, []), VerbError);
  });

  it('composite keys: a row is a duplicate only when every part matches', () => {
    const classify = createShapeClassifier();
    const store = createDatasetStore({ classify, buildDigest, turnId: 'turn-test' });
    const engine = createVerbEngine({ store, classify });
    const { datasetId } = store.internToolResult('x', [
      { k1: 'a1b2c3d4e5f60001', k2: 'f6e5d4c3b2a10002' },
      { k1: 'a1b2c3d4e5f60001', k2: 'f6e5d4c3b2a10003' },
      { k1: 'a1b2c3d4e5f60001', k2: 'f6e5d4c3b2a10002' },
    ]);
    const d = engine.distinct(datasetId, ['k1', 'k2']);
    assert.equal(store.get(d.datasetId)!.rows.length, 2);
  });
});
