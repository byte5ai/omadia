import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { InMemoryKnowledgeGraph } from '@omadia/knowledge-graph-inmemory';

import {
  buildDatasetFromCsv,
  importCsvDataset,
  parseCsv,
  MAX_DATASET_ROWS,
} from '../packages/harness-orchestrator/src/datasetImport.js';

describe('parseCsv', () => {
  it('parses header + rows into header-keyed string records', () => {
    const csv = 'name,age\nAda,36\nGrace,85\n';
    const result = parseCsv(Buffer.from(csv, 'utf8'));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.headers, ['name', 'age']);
    assert.deepEqual(result.rows, [
      { name: 'Ada', age: '36' },
      { name: 'Grace', age: '85' },
    ]);
  });

  it('rejects a CSV with no data rows', () => {
    const result = parseCsv(Buffer.from('name,age\n', 'utf8'));
    assert.equal(result.ok, false);
  });

  it('rejects a CSV over the row cap', () => {
    const header = 'v\n';
    const rows = Array.from({ length: MAX_DATASET_ROWS + 1 }, (_, i) => String(i)).join('\n');
    const result = parseCsv(Buffer.from(header + rows, 'utf8'));
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.reason, /row/i);
  });

  it('reports zero truncation for a CSV with no over-limit cells', () => {
    const result = parseCsv(Buffer.from('name,age\nAda,36\n', 'utf8'));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.truncation.truncatedCellCount, 0);
    assert.deepEqual(result.truncation.truncatedColumns, []);
  });

  it('#430 fixup — surfaces truncatedCellCount + truncatedColumns instead of silently cutting an over-limit cell', () => {
    const longValue = 'x'.repeat(5000);
    const csv = `name,notes\nAda,${longValue}\nGrace,short\n`;
    const result = parseCsv(Buffer.from(csv, 'utf8'));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.truncation.truncatedCellCount, 1);
    assert.deepEqual(result.truncation.truncatedColumns, ['notes']);
    // The cell is still cut (protects storage/scan) — just no longer silent.
    assert.equal(result.rows[0]?.['notes']?.length, 4000);
  });
});

describe('buildDatasetFromCsv — column type inference', () => {
  it('infers number, boolean, and string columns', async () => {
    const csv = 'name,age,active\nAda,36,true\nGrace,85,false\n';
    const built = await buildDatasetFromCsv(Buffer.from(csv, 'utf8'));
    assert.equal(built.ok, true);
    if (!built.ok) return;
    const byName = new Map(built.columns.map((c) => [c.name, c]));
    assert.equal(byName.get('name')?.type, 'string');
    assert.equal(byName.get('age')?.type, 'number');
    assert.equal(byName.get('active')?.type, 'boolean');
    assert.equal(built.rows[0]?.['age'], 36);
    assert.equal(built.rows[0]?.['active'], true);
  });

  it('falls back to string when a column has one non-conforming value', async () => {
    const csv = 'code\n123\nAB12\n';
    const built = await buildDatasetFromCsv(Buffer.from(csv, 'utf8'));
    assert.equal(built.ok, true);
    if (!built.ok) return;
    assert.equal(built.columns[0]?.type, 'string');
    assert.equal(built.rows[0]?.['code'], '123');
  });
});

describe('buildDatasetFromCsv — privacy scan', () => {
  it('masks an email found in a string column before storage', async () => {
    const csv = 'name,contact\nAda,ada@example.com\n';
    const built = await buildDatasetFromCsv(Buffer.from(csv, 'utf8'));
    assert.equal(built.ok, true);
    if (!built.ok) return;
    const contact = String(built.rows[0]?.['contact'] ?? '');
    assert.ok(!contact.includes('ada@example.com'), 'raw email must not survive the scan');
    assert.equal(built.privacyScan.maskedCells, 1);
  });

  it('does not scan (and cannot corrupt) a number-typed column', async () => {
    const csv = 'id,amount\n1,1000\n2,2000\n';
    const built = await buildDatasetFromCsv(Buffer.from(csv, 'utf8'));
    assert.equal(built.ok, true);
    if (!built.ok) return;
    assert.equal(built.rows[0]?.['amount'], 1000);
    assert.equal(built.rows[1]?.['amount'], 2000);
  });

  it('types a zero-padded, digit-only column as string — not number — so a short zero-padded code round-trips without corruption (#430 fixup)', async () => {
    // '012'/'019' are short enough that the baseline PII detector does not
    // treat them as phone-number-shaped, so this case isolates the
    // type-inference fix in the clear: no privacy-masking noise, just proof
    // that the leading zero is no longer silently dropped by `Number()`.
    const csv = 'name,code\nAda,012\nGrace,019\n';
    const built = await buildDatasetFromCsv(Buffer.from(csv, 'utf8'));
    assert.equal(built.ok, true);
    if (!built.ok) return;

    const byName = new Map(built.columns.map((c) => [c.name, c]));
    assert.equal(
      byName.get('code')?.type,
      'string',
      'a leading-zero digit string must not be typed number',
    );
    // Value round-trips with its leading zero intact — Number() would have
    // silently dropped it (e.g. '012' -> 12).
    assert.equal(built.rows[0]?.['code'], '012');
    assert.equal(built.rows[1]?.['code'], '019');
    // The column is string-typed, so the mandatory privacy scan actually
    // runs over it (2 cells) instead of being bypassed the way a
    // number-typed column is (see the sibling test above).
    assert.ok(
      built.privacyScan.scannedCells >= 2,
      `expected the leading-zero column to be scanned, got scannedCells=${String(built.privacyScan.scannedCells)}`,
    );

    // A bare '0'/'0.x' decimal is still a legitimate number column.
    const decimalCsv = 'ratio\n0\n0.5\n';
    const decimalBuilt = await buildDatasetFromCsv(Buffer.from(decimalCsv, 'utf8'));
    assert.equal(decimalBuilt.ok, true);
    if (!decimalBuilt.ok) return;
    assert.equal(decimalBuilt.columns[0]?.type, 'number');
  });

  it('types a signed, zero-padded column as string — not number — so a negative zero-padded code round-trips without corruption (#430 fixup round 6)', async () => {
    // Before this fix, LEADING_ZERO_RE only matched an unsigned leading
    // zero ('0123'), so a signed zero-padded value like '-012' still
    // passed NUMBER_RE (which allows an optional leading '-') without
    // tripping the leading-zero guard. That silently mistyped the column
    // as 'number' (Number('-012') === -12, dropping the leading zero) and
    // skipped the mandatory privacy scan. '012'/'019' (as opposed to a
    // longer digit run) are short enough that the baseline PII detector's
    // phone pattern does not also fire, isolating the type-inference fix.
    const csv = 'name,code\nAda,-012\nGrace,-019\n';
    const built = await buildDatasetFromCsv(Buffer.from(csv, 'utf8'));
    assert.equal(built.ok, true);
    if (!built.ok) return;

    const byName = new Map(built.columns.map((c) => [c.name, c]));
    assert.equal(
      byName.get('code')?.type,
      'string',
      'a signed leading-zero digit string must not be typed number',
    );
    // Value round-trips with its sign and leading zero intact — Number()
    // would have silently dropped the zero (e.g. '-012' -> -12).
    assert.equal(built.rows[0]?.['code'], '-012');
    assert.equal(built.rows[1]?.['code'], '-019');
    // The column is string-typed, so the mandatory privacy scan actually
    // runs over it instead of being bypassed the way a number-typed
    // column is.
    assert.ok(
      built.privacyScan.scannedCells >= 2,
      `expected the signed leading-zero column to be scanned, got scannedCells=${String(built.privacyScan.scannedCells)}`,
    );

    // A bare '0'/'-0.x' decimal is still a legitimate number column.
    const decimalCsv = 'ratio\n-0\n-0.5\n';
    const decimalBuilt = await buildDatasetFromCsv(Buffer.from(decimalCsv, 'utf8'));
    assert.equal(decimalBuilt.ok, true);
    if (!decimalBuilt.ok) return;
    assert.equal(decimalBuilt.columns[0]?.type, 'number');
  });

  it('a zero-padded phone number no longer bypasses the mandatory privacy scan (#430 fixup — the exact scenario from the reviewer report)', async () => {
    // Before the fix, '0301234567' was inferred as type 'number': the raw
    // digits were stored via `Number()` (silently dropping the leading
    // zero, corrupting the value to 301234567) AND the column was excluded
    // from the privacy scan entirely — a real German phone number would
    // have been persisted un-redacted. After the fix the column is typed
    // 'string', so it goes through the same mandatory C0 scan as any other
    // free-text column and gets masked like the shipped phone-number
    // pattern is meant to.
    const csv = 'name,phone\nAda,0301234567\nGrace,0301234568\n';
    const built = await buildDatasetFromCsv(Buffer.from(csv, 'utf8'));
    assert.equal(built.ok, true);
    if (!built.ok) return;

    const byName = new Map(built.columns.map((c) => [c.name, c]));
    assert.equal(byName.get('phone')?.type, 'string');

    const stored = String(built.rows[0]?.['phone'] ?? '');
    // Never the leading-zero-dropped, `Number()`-corrupted value.
    assert.notEqual(stored, '301234567');
    // Never the raw, un-redacted phone number either — the scan must have
    // masked it, proving the bypass is closed.
    assert.notEqual(stored, '0301234567');
    assert.ok(
      built.privacyScan.scannedCells >= 2,
      `expected the phone column to be scanned, got scannedCells=${String(built.privacyScan.scannedCells)}`,
    );
    assert.ok(
      built.privacyScan.maskedCells >= 1,
      'expected the phone number to be masked by the baseline detector',
    );
  });

  it('#727 — an ISO-8601 date column is stored as its real dates, not masked to a phone surrogate at rest', async () => {
    // The reported corruption: a `date`-typed column of ISO dates was run
    // through the masker, which mis-typed `2026-07-02` as a phone and
    // persisted `+49 30 55590000` — destroying the column irreversibly (no
    // map retained) and contradicting the declared `date` type. Date columns
    // are now excluded from the scan (like number/boolean), so the real,
    // DISTINCT dates are stored and the schema stays honest.
    const csv =
      'customer,order_date\n' +
      'Meier GmbH,2026-07-02\n' +
      'Weber AG,2026-08-01\n';
    const built = await buildDatasetFromCsv(Buffer.from(csv, 'utf8'));
    assert.equal(built.ok, true);
    if (!built.ok) return;

    const byName = new Map(built.columns.map((c) => [c.name, c]));
    assert.equal(byName.get('order_date')?.type, 'date');

    // Read the values back OUT of the produced rows (the persisted artifact),
    // not the renderer input: real dates, distinct per row, no phone leak.
    assert.equal(built.rows[0]?.['order_date'], '2026-07-02');
    assert.equal(built.rows[1]?.['order_date'], '2026-08-01');
    assert.notEqual(built.rows[0]?.['order_date'], built.rows[1]?.['order_date']);
    for (const row of built.rows) {
      assert.ok(!String(row['order_date']).includes('+49'), 'a date must never become a phone surrogate');
    }

    // The schema sample no longer advertises a type the stored value contradicts.
    assert.equal(byName.get('order_date')?.sample, '2026-07-02');

    // The date column was NOT scanned — only the two `customer` (string) cells
    // were. This pins the "skip date columns" decision, not just its effect.
    assert.equal(
      built.privacyScan.scannedCells,
      2,
      'only the string column may be scanned; the date column must be skipped',
    );
  });
});

describe('importCsvDataset', () => {
  it('persists a dataset + rows via KnowledgeGraph.ingestDataset', async () => {
    const graph = new InMemoryKnowledgeGraph();
    const csv = 'name,age\nAda,36\nGrace,85\n';
    const imported = await importCsvDataset({
      graph,
      bytes: Buffer.from(csv, 'utf8'),
      datasetName: 'People',
      sourceFileName: 'people.csv',
      ownerOmadiaUserId: 'user-1',
    });
    assert.equal(imported.ok, true);
    if (!imported.ok) return;
    assert.equal(imported.result.rowCount, 2);

    const dataset = await graph.getDataset(imported.result.datasetId, 'user-1');
    assert.ok(dataset);
    assert.equal(dataset?.name, 'People');
    assert.equal(dataset?.rowCount, 2);
    assert.equal(imported.truncation.truncatedCellCount, 0);
  });

  it('#430 fixup — threads truncation stats through to the top-level import result', async () => {
    const graph = new InMemoryKnowledgeGraph();
    const longValue = 'y'.repeat(4500);
    const imported = await importCsvDataset({
      graph,
      bytes: Buffer.from(`name,bio\nAda,${longValue}\n`, 'utf8'),
      datasetName: 'Bios',
      sourceFileName: 'bios.csv',
      ownerOmadiaUserId: 'user-1',
    });
    assert.equal(imported.ok, true);
    if (!imported.ok) return;
    assert.equal(imported.truncation.truncatedCellCount, 1);
    assert.deepEqual(imported.truncation.truncatedColumns, ['bio']);
  });

  it('surfaces a clean failure reason for a malformed CSV instead of throwing', async () => {
    const graph = new InMemoryKnowledgeGraph();
    const imported = await importCsvDataset({
      graph,
      bytes: Buffer.from('', 'utf8'),
      datasetName: 'Empty',
      sourceFileName: 'empty.csv',
      ownerOmadiaUserId: 'user-1',
    });
    assert.equal(imported.ok, false);
  });
});
