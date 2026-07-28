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
