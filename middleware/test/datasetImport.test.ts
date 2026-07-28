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
