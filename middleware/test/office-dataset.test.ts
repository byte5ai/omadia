import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { Readable } from 'node:stream';
import type { TigrisStore } from '@omadia/diagrams';
import { createPrivacyGuardService } from '@omadia/plugin-privacy-guard';
import { OfficeService, OfficeTool } from '@omadia/plugin-office';

const SECRET = 'z'.repeat(32);

class InMemoryStore implements TigrisStore {
  private objects = new Map<string, { body: Buffer; contentType?: string }>();
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

function makeService(): OfficeService {
  return new OfficeService({
    store: new InMemoryStore(),
    secret: SECRET,
    publicBaseUrl: 'https://bot.example.com',
    tenantId: 'dev',
    signedUrlTtlSec: 60,
  });
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
});
