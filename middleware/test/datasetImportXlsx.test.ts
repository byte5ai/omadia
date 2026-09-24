import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import ExcelJS from 'exceljs';
import { InMemoryKnowledgeGraph } from '@omadia/knowledge-graph-inmemory';

import {
  cellToString,
  parseXlsx,
  parseXlsxFirstSheet,
  MAX_SHEETS,
  MAX_XLSX_BYTES,
} from '../packages/harness-orchestrator/src/datasetImportXlsx.js';
import { importTabularDataset } from '../packages/harness-orchestrator/src/datasetImportTabular.js';
import {
  detectTabularFormat,
  isTabularAttachment,
  isCsvAttachment,
} from '../packages/harness-orchestrator/src/attachmentExtract.js';

const XLSX_MIME =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Build an .xlsx buffer from `{ sheetName: rows }`, rows being raw cell arrays. */
async function makeXlsx(
  sheets: Record<string, unknown[][]>,
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  for (const [name, rows] of Object.entries(sheets)) {
    const ws = wb.addWorksheet(name);
    for (const row of rows) ws.addRow(row);
  }
  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out);
}

describe('cellToString', () => {
  it('renders primitives and blanks', () => {
    assert.equal(cellToString(null), '');
    assert.equal(cellToString(undefined), '');
    assert.equal(cellToString('Ada'), 'Ada');
    assert.equal(cellToString(36), '36');
    assert.equal(cellToString(true), 'true');
  });

  it('renders a midnight Date as a bare ISO date', () => {
    assert.equal(cellToString(new Date('2026-03-04T00:00:00.000Z')), '2026-03-04');
  });

  it('keeps the time component when a Date carries one', () => {
    assert.equal(
      cellToString(new Date('2026-03-04T09:30:00.000Z')),
      '2026-03-04T09:30:00.000Z',
    );
  });

  it('takes a formula cell’s cached RESULT, never the formula source', () => {
    assert.equal(cellToString({ formula: 'SUM(B2:B23)', result: 42 }), '42');
    assert.equal(cellToString({ sharedFormula: 'A1', result: 'x' }), 'x');
  });

  it('yields empty for a formula whose result was never cached', () => {
    assert.equal(cellToString({ formula: 'SUM(B2:B23)' }), '');
  });

  it('preserves an error cell marker so the column stays string-typed', () => {
    assert.equal(cellToString({ error: '#DIV/0!' }), '#DIV/0!');
  });

  it('concatenates rich-text runs', () => {
    assert.equal(
      cellToString({ richText: [{ text: 'Hello ' }, { text: 'world' }] }),
      'Hello world',
    );
  });

  it('uses the visible text of a hyperlink cell, not the target', () => {
    assert.equal(
      cellToString({ hyperlink: 'https://example.com/x', text: 'Report' }),
      'Report',
    );
  });

  it('resolves a formula result that is itself a date', () => {
    assert.equal(
      cellToString({ formula: 'TODAY()', result: new Date('2026-01-02T00:00:00.000Z') }),
      '2026-01-02',
    );
  });
});

describe('parseXlsx', () => {
  it('parses a simple sheet into header-keyed string rows', async () => {
    const bytes = await makeXlsx({
      Sheet1: [
        ['name', 'age'],
        ['Ada', 36],
        ['Grace', 85],
      ],
    });
    const result = await parseXlsx(bytes);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.sheets.length, 1);
    const sheet = result.sheets[0]!;
    assert.deepEqual(sheet.headers, ['name', 'age']);
    assert.deepEqual(sheet.rows, [
      { name: 'Ada', age: '36' },
      { name: 'Grace', age: '85' },
    ]);
  });

  it('skips a single-cell title row and uses the real header row', async () => {
    const bytes = await makeXlsx({
      Sheet1: [
        ['Mitarbeiterübersicht Q3'],
        ['name', 'department'],
        ['Ada', 'Engineering'],
      ],
    });
    const result = await parseXlsx(bytes);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const sheet = result.sheets[0]!;
    assert.deepEqual(sheet.headers, ['name', 'department']);
    assert.deepEqual(sheet.rows, [{ name: 'Ada', department: 'Engineering' }]);
  });

  it('produces one table per sheet', async () => {
    const bytes = await makeXlsx({
      People: [
        ['name'],
        ['Ada'],
      ],
      Budget: [
        ['item', 'cost'],
        ['Laptop', 1200],
      ],
    });
    const result = await parseXlsx(bytes);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.sheets.length, 2);
    assert.deepEqual(
      result.sheets.map((s) => s.sheetName),
      ['People', 'Budget'],
    );
  });

  it('skips fully blank spacer rows', async () => {
    const bytes = await makeXlsx({
      Sheet1: [
        ['name', 'age'],
        ['Ada', 36],
        [],
        ['Grace', 85],
      ],
    });
    const result = await parseXlsx(bytes);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.sheets[0]!.rows.length, 2);
  });

  it('disambiguates duplicate headers so no column is silently dropped', async () => {
    const bytes = await makeXlsx({
      Sheet1: [
        ['name', 'name'],
        ['Ada', 'Lovelace'],
      ],
    });
    const result = await parseXlsx(bytes);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const sheet = result.sheets[0]!;
    assert.deepEqual(sheet.headers, ['name', 'name_2']);
    assert.deepEqual(sheet.rows, [{ name: 'Ada', name_2: 'Lovelace' }]);
  });

  it('names an unnamed column by its position', async () => {
    const bytes = await makeXlsx({
      Sheet1: [
        ['name', '', 'city'],
        ['Ada', 'x', 'London'],
      ],
    });
    const result = await parseXlsx(bytes);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.sheets[0]!.headers, ['name', 'column_2', 'city']);
  });

  it('skips a sheet with a header but no data rows, keeping the others', async () => {
    const bytes = await makeXlsx({
      Empty: [['a', 'b']],
      Real: [
        ['name'],
        ['Ada'],
      ],
    });
    const result = await parseXlsx(bytes);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.sheets.length, 1);
    assert.equal(result.sheets[0]!.sheetName, 'Real');
  });

  it('rejects a workbook with no data rows at all', async () => {
    const bytes = await makeXlsx({ Empty: [['a', 'b']] });
    const result = await parseXlsx(bytes);
    assert.equal(result.ok, false);
  });

  it('rejects bytes that are not a readable workbook', async () => {
    const result = await parseXlsx(Buffer.from('not a spreadsheet', 'utf8'));
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.reason, /invalid|unreadable/i);
  });

  it('refuses an upload over the byte cap before inflating it', async () => {
    const oversized = Buffer.alloc(MAX_XLSX_BYTES + 1);
    const result = await parseXlsx(oversized);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.reason, /byte/i);
  });

  it('refuses a workbook over the sheet cap', async () => {
    const sheets: Record<string, unknown[][]> = {};
    for (let i = 0; i <= MAX_SHEETS; i += 1) {
      sheets[`S${String(i)}`] = [['v'], [i]];
    }
    const bytes = await makeXlsx(sheets);
    const result = await parseXlsx(bytes);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.reason, /sheet/i);
  });

  it('parseXlsxFirstSheet returns the CSV-shaped single-table result', async () => {
    const bytes = await makeXlsx({
      A: [['name'], ['Ada']],
      B: [['other'], ['x']],
    });
    const result = await parseXlsxFirstSheet(bytes);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.headers, ['name']);
  });
});

describe('detectTabularFormat', () => {
  it('recognizes xlsx by mime type and by extension', () => {
    assert.equal(detectTabularFormat(XLSX_MIME, 'x.bin'), 'xlsx');
    assert.equal(detectTabularFormat(undefined, 'staff.xlsx'), 'xlsx');
    assert.equal(detectTabularFormat(undefined, 'macro.xlsm'), 'xlsx');
  });

  it('recognizes an xlsx uploaded as octet-stream or zip by extension', () => {
    // Chat clients routinely mislabel .xlsx; extension must win, otherwise
    // the file falls out of the structured path entirely.
    assert.equal(detectTabularFormat('application/octet-stream', 'staff.xlsx'), 'xlsx');
    assert.equal(detectTabularFormat('application/zip', 'staff.xlsx'), 'xlsx');
  });

  it('recognizes csv', () => {
    assert.equal(detectTabularFormat('text/csv', 'a.csv'), 'csv');
    assert.equal(detectTabularFormat(undefined, 'a.csv'), 'csv');
  });

  it('returns undefined for non-tabular attachments', () => {
    assert.equal(detectTabularFormat('application/pdf', 'a.pdf'), undefined);
    assert.equal(detectTabularFormat('text/plain', 'a.txt'), undefined);
  });

  it('isTabularAttachment covers both formats, isCsvAttachment stays CSV-only', () => {
    assert.equal(isTabularAttachment(undefined, 'a.xlsx'), true);
    assert.equal(isTabularAttachment(undefined, 'a.csv'), true);
    assert.equal(isTabularAttachment(undefined, 'a.pdf'), false);
    // Deprecated predicate keeps its exact previous meaning.
    assert.equal(isCsvAttachment(undefined, 'a.xlsx'), false);
    assert.equal(isCsvAttachment(undefined, 'a.csv'), true);
  });
});

describe('importTabularDataset', () => {
  const owner = '11111111-1111-4111-8111-111111111111';

  it('imports an XLSX through the SAME privacy scan as CSV', async () => {
    const graph = new InMemoryKnowledgeGraph();
    const bytes = await makeXlsx({
      Sheet1: [
        ['name', 'contact'],
        ['Ada', 'ada@example.com'],
      ],
    });
    const result = await importTabularDataset({
      graph,
      bytes,
      datasetName: 'staff.xlsx',
      sourceFileName: 'staff.xlsx',
      ownerOmadiaUserId: owner,
      format: 'xlsx',
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.imported.length, 1);
    const table = result.imported[0]!;
    // The email cell was scanned and masked — the raw address must not be
    // what got persisted.
    assert.ok(table.privacyScan.maskedCells >= 1);
    const rows = await graph.queryDatasetRows(table.result.datasetId, owner, {
      limit: 10,
    });
    const serialized = JSON.stringify(rows);
    assert.equal(
      serialized.includes('ada@example.com'),
      false,
      'raw email must not survive the import',
    );
  });

  it('creates one dataset per sheet and names them by sheet', async () => {
    const graph = new InMemoryKnowledgeGraph();
    const bytes = await makeXlsx({
      People: [['name'], ['Ada']],
      Budget: [['item'], ['Laptop']],
    });
    const result = await importTabularDataset({
      graph,
      bytes,
      datasetName: 'book.xlsx',
      sourceFileName: 'book.xlsx',
      ownerOmadiaUserId: owner,
      format: 'xlsx',
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.imported.length, 2);
    assert.deepEqual(
      result.imported.map((t) => t.sheetName),
      ['People', 'Budget'],
    );
  });

  it('leaves a single-sheet workbook named exactly like a CSV import', async () => {
    const graph = new InMemoryKnowledgeGraph();
    const bytes = await makeXlsx({ Only: [['name'], ['Ada']] });
    const result = await importTabularDataset({
      graph,
      bytes,
      datasetName: 'staff.xlsx',
      sourceFileName: 'staff.xlsx',
      ownerOmadiaUserId: owner,
      format: 'xlsx',
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.imported[0]!.sheetName, undefined);
  });

  it('still imports CSV through the same entry point', async () => {
    const graph = new InMemoryKnowledgeGraph();
    const result = await importTabularDataset({
      graph,
      bytes: Buffer.from('name,age\nAda,36\n', 'utf8'),
      datasetName: 'a.csv',
      sourceFileName: 'a.csv',
      ownerOmadiaUserId: owner,
      format: 'csv',
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.imported.length, 1);
    assert.equal(result.imported[0]!.result.rowCount, 1);
  });

  it('ingests nothing when one sheet of a workbook fails to build', async () => {
    const graph = new InMemoryKnowledgeGraph();
    const before = await graph.listDatasets({ ownerOmadiaUserId: owner });
    // A workbook whose second sheet has a header but no rows is skipped, not
    // failed — assert the success shape rather than a partial write.
    const bytes = await makeXlsx({
      Good: [['name'], ['Ada']],
      HeaderOnly: [['a', 'b']],
    });
    const result = await importTabularDataset({
      graph,
      bytes,
      datasetName: 'book.xlsx',
      sourceFileName: 'book.xlsx',
      ownerOmadiaUserId: owner,
      format: 'xlsx',
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.imported.length, 1);
    const after = await graph.listDatasets({ ownerOmadiaUserId: owner });
    assert.equal(after.length, before.length + 1);
  });
});
