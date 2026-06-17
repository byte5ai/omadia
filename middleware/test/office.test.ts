import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import ExcelJS from 'exceljs';
import {
  renderXlsx,
  renderDocx,
  sanitizeFilename,
  signDocumentUrl,
  verifyDocumentSig,
  MEDIA_TYPE,
  type XlsxDescriptor,
  type DocxDescriptor,
} from '@omadia/plugin-office';

const SECRET = 'z'.repeat(32);

describe('office xlsx renderer', () => {
  const descriptor: XlsxDescriptor = {
    filename: 'offene posten',
    title: 'Offene Posten',
    sheets: [
      {
        name: 'Offene Posten',
        columns: [
          { key: 'datum', header: 'Datum', type: 'date' },
          { key: 'partner', header: 'Partner', type: 'text' },
          { key: 'betrag', header: 'Offener Betrag', type: 'currency', currency: 'EUR' },
        ],
        rows: [
          { datum: '2026-05-01', partner: 'Acme GmbH', betrag: 1234.5 },
          { datum: '2026-05-12', partner: 'Beta AG', betrag: 999 },
        ],
      },
    ],
  };

  it('renders a parseable workbook with headers, rows and number formats', async () => {
    const result = await renderXlsx(descriptor);
    assert.equal(result.mediaType, MEDIA_TYPE.xlsx);
    assert.equal(result.ext, 'xlsx');
    assert.equal(result.filename, 'offene posten.xlsx');
    assert.equal(result.rowsWritten, 2);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(result.buffer);
    const ws = wb.getWorksheet('Offene Posten');
    assert.ok(ws, 'worksheet exists');

    // Header row.
    assert.equal(ws.getCell('A1').value, 'Datum');
    assert.equal(ws.getCell('B1').value, 'Partner');
    assert.equal(ws.getCell('C1').value, 'Offener Betrag');

    // Data: currency is a real number (summable), date is a real Date.
    assert.equal(ws.getCell('C2').value, 1234.5);
    assert.ok(ws.getCell('A2').value instanceof Date, 'date cell coerced to Date');

    // Number format carries the euro symbol.
    assert.match(ws.getCell('C2').numFmt ?? '', /€/);
  });

  it('is deterministic — same descriptor yields identical bytes', async (t) => {
    // exceljs stamps the ZIP entry mtimes with the wall clock (DOS 2-second
    // granularity) and exposes no API to pin them, so two renders that straddle
    // a 2s boundary differ even though the logical workbook + pinned
    // created/modified are identical — a timing flake in slow CI (passes
    // locally where both renders land in the same window). Freeze the clock
    // across both renders so the byte-equality verifies renderer determinism
    // rather than wall-clock timing. (Freezing Date globally inside the
    // renderer itself would be unsafe under concurrent async on the server.)
    t.mock.timers.enable({ apis: ['Date'], now: 1_700_000_000_000 });
    try {
      const a = await renderXlsx(descriptor);
      const b = await renderXlsx(descriptor);
      assert.ok(a.buffer.equals(b.buffer), 'pinned metadata → byte-identical');
    } finally {
      t.mock.timers.reset();
    }
  });

  it('counts rowsWritten across sheets', async () => {
    const multi: XlsxDescriptor = {
      sheets: [
        { name: 'A', columns: [{ key: 'x', header: 'X' }], rows: [{ x: 1 }, { x: 2 }, { x: 3 }] },
        { name: 'B', columns: [{ key: 'y', header: 'Y' }], rows: [{ y: 'a' }] },
      ],
    };
    const result = await renderXlsx(multi);
    assert.equal(result.rowsWritten, 4);
  });

  it('renders formula cells with cross-sheet references', async () => {
    const descriptor: XlsxDescriptor = {
      sheets: [
        {
          name: 'Data',
          columns: [
            { key: 'monat', header: 'Monat' },
            { key: 'betrag', header: 'Betrag', type: 'currency' },
          ],
          rows: [
            { monat: 'Jan', betrag: 100 },
            { monat: 'Feb', betrag: 200 },
          ],
        },
        {
          name: 'Pivot',
          columns: [
            { key: 'label', header: 'Label' },
            { key: 'summe', header: 'Summe', type: 'currency' },
          ],
          // Cross-sheet formula referencing the Data sheet.
          rows: [{ label: 'Gesamt', summe: { formula: 'SUM(Data!B2:B3)' } }],
        },
      ],
    };
    const result = await renderXlsx(descriptor);
    assert.equal(result.rowsWritten, 3); // 2 data + 1 pivot

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(result.buffer);
    const pivot = wb.getWorksheet('Pivot');
    assert.ok(pivot, 'pivot sheet exists');
    const cell = pivot.getCell('B2'); // row 2, col B = "summe"
    const value = cell.value as { formula?: string } | undefined;
    const formula = cell.formula ?? value?.formula;
    assert.equal(formula, 'SUM(Data!B2:B3)', 'formula written verbatim');
  });

  it('renders computed (per-row formula) columns with {row} substitution', async () => {
    const descriptor: XlsxDescriptor = {
      sheets: [
        {
          name: 'Daten',
          columns: [
            { key: 'datum', header: 'Datum', type: 'date' },
            { key: 'betrag', header: 'Betrag', type: 'currency' },
            // Computed helper column — A{row} = the date column, per row.
            { key: 'monat', header: 'Monat', formula: 'TEXT(A{row},"YYYY-MM")' },
          ],
          rows: [
            { datum: '2026-01-15', betrag: 100 },
            { datum: '2026-02-20', betrag: 200 },
          ],
        },
      ],
    };
    const result = await renderXlsx(descriptor);
    assert.equal(result.rowsWritten, 2);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(result.buffer);
    const ws = wb.getWorksheet('Daten');
    assert.ok(ws);
    // "Monat" is column C; the two data rows are Excel rows 2 and 3.
    const f2 = (ws.getCell('C2').value as { formula?: string } | undefined)?.formula;
    const f3 = (ws.getCell('C3').value as { formula?: string } | undefined)?.formula;
    assert.equal(f2, 'TEXT(A2,"YYYY-MM")', 'row 2 → A2');
    assert.equal(f3, 'TEXT(A3,"YYYY-MM")', 'row 3 → A3');
  });
});

describe('office docx renderer', () => {
  it('renders a valid .docx (zip) from blocks', async () => {
    const descriptor: DocxDescriptor = {
      filename: 'bericht',
      title: 'Quartalsbericht',
      blocks: [
        { type: 'heading', level: 1, text: 'Zusammenfassung' },
        { type: 'paragraph', text: 'Dies ist ein Absatz.' },
        { type: 'bullets', items: ['Punkt eins', 'Punkt zwei'] },
        { type: 'table', headers: ['A', 'B'], rows: [['1', '2'], ['3', '4']] },
      ],
    };
    const result = await renderDocx(descriptor);
    assert.equal(result.mediaType, MEDIA_TYPE.docx);
    assert.equal(result.filename, 'bericht.docx');
    assert.equal(result.rowsWritten, 0);
    // OOXML is a zip — bytes start with the local-file-header magic "PK".
    assert.equal(result.buffer[0], 0x50);
    assert.equal(result.buffer[1], 0x4b);
    assert.ok(result.buffer.length > 1000, 'non-trivial document');
  });
});

describe('office signed-url roundtrip', () => {
  function parse(url: string): { key: string; exp: number; sig: string } {
    const u = new URL(url);
    const key = decodeURIComponent(u.pathname.replace(/^\/documents\//, ''));
    return {
      key,
      exp: Number(u.searchParams.get('exp')),
      sig: u.searchParams.get('sig') ?? '',
    };
  }

  it('signs and verifies a fresh url', () => {
    const url = signDocumentUrl({
      key: 'documents/dev/abc/report.xlsx',
      secret: SECRET,
      ttlSec: 3600,
      publicBaseUrl: 'https://bot.example.com',
      nowSec: 1000,
    });
    const { key, exp, sig } = parse(url);
    assert.equal(key, 'documents/dev/abc/report.xlsx');
    assert.ok(verifyDocumentSig({ key, exp, sig, secret: SECRET, nowSec: 1000 }));
  });

  it('rejects expired urls', () => {
    const url = signDocumentUrl({
      key: 'documents/dev/abc/report.xlsx',
      secret: SECRET,
      ttlSec: 60,
      publicBaseUrl: 'https://bot.example.com',
      nowSec: 1000,
    });
    const { key, exp, sig } = parse(url);
    assert.equal(verifyDocumentSig({ key, exp, sig, secret: SECRET, nowSec: 9999 }), false);
  });

  it('rejects tampered keys', () => {
    const url = signDocumentUrl({
      key: 'documents/dev/abc/report.xlsx',
      secret: SECRET,
      ttlSec: 60,
      publicBaseUrl: 'https://bot.example.com',
      nowSec: 1000,
    });
    const { exp, sig } = parse(url);
    assert.equal(
      verifyDocumentSig({ key: 'documents/dev/abc/OTHER.xlsx', exp, sig, secret: SECRET, nowSec: 1000 }),
      false,
    );
  });
});

describe('office filename sanitizer', () => {
  it('appends the extension and keeps a readable base', () => {
    assert.equal(sanitizeFilename('Offene Posten', 'xlsx', 'export'), 'Offene Posten.xlsx');
  });
  it('strips path separators and a redundant extension', () => {
    const out = sanitizeFilename('../../etc/report.xlsx', 'xlsx', 'export');
    assert.ok(!out.includes('/') && !out.includes('\\'), 'no path separators survive');
    assert.ok(out.endsWith('.xlsx') && !out.endsWith('.xlsx.xlsx'), 'single correct extension');
  });
  it('falls back when empty', () => {
    assert.equal(sanitizeFilename('', 'docx', 'document'), 'document.docx');
    assert.equal(sanitizeFilename(undefined, 'docx', 'document'), 'document.docx');
  });
});
