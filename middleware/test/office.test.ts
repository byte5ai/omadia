import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { Readable } from 'node:stream';
import ExcelJS from 'exceljs';
import type { TigrisStore } from '@omadia/diagrams';
import {
  renderXlsx,
  renderDocx,
  attachmentDisposition,
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
  type XlsxDescriptor,
  type DocxDescriptor,
} from '@omadia/plugin-office';
import { unzipToText, zipEntryDosStamps } from './_helpers/unzipToText.js';

const SECRET = 'z'.repeat(32);

/** Open rendered .xlsx bytes. exceljs declares its own `Buffer extends
 *  ArrayBuffer`; same cast as datasetImportXlsx.ts. */
async function loadWorkbook(buffer: Buffer): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  return wb;
}

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

    const wb = await loadWorkbook(result.buffer);
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
    const wb = await loadWorkbook(result.buffer);
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

    const wb = await loadWorkbook(result.buffer);
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

    const wb = await loadWorkbook(result.buffer);
    const ws = wb.getWorksheet('Daten');
    assert.ok(ws);
    // "Monat" is column C; the two data rows are Excel rows 2 and 3.
    const f2 = (ws.getCell('C2').value as { formula?: string } | undefined)?.formula;
    const f3 = (ws.getCell('C3').value as { formula?: string } | undefined)?.formula;
    assert.equal(f2, 'TEXT(A2,"YYYY-MM")', 'row 2 → A2');
    assert.equal(f3, 'TEXT(A3,"YYYY-MM")', 'row 3 → A3');
  });

  it('renames the sheet name Excel reserves ("History") instead of failing the file (#1982)', async () => {
    // Excel reserves the name in any case; exceljs only refuses "History".
    for (const [name, expected] of [
      ['History', 'History_'],
      [' history ', 'history_'],
    ] as const) {
      const result = await renderXlsx({
        sheets: [{ name, columns: [{ key: 'x', header: 'X' }], rows: [{ x: 1 }] }],
      });
      assert.equal(result.rowsWritten, 1);

      const wb = await loadWorkbook(result.buffer);
      assert.deepEqual(
        wb.worksheets.map((ws) => ws.name),
        [expected],
      );
    }
  });

  it('cuts a long sheet name without splitting an emoji into a lone surrogate', async () => {
    // 30 letters + an emoji (two UTF-16 units) crosses the 31-unit cap mid-pair.
    const long = `${'a'.repeat(30)}\u{1F600}x`;
    const result = await renderXlsx({
      sheets: [
        { name: long, columns: [{ key: 'x', header: 'X' }], rows: [{ x: 1 }] },
        { name: long, columns: [{ key: 'x', header: 'X' }], rows: [{ x: 2 }] },
      ],
    });
    const wb = await loadWorkbook(result.buffer);
    const names = wb.worksheets.map((ws) => ws.name);
    assert.deepEqual(names, ['a'.repeat(30), `${'a'.repeat(27)} (2)`]);
    for (const name of names) assert.ok(!/[\uD800-\uDFFF]/.test(name), `"${name}" has no lone surrogate`);

    const emojiEnd = await renderXlsx({
      sheets: [{ name: `${'b'.repeat(29)}\u{1F600}z`, columns: [{ key: 'x', header: 'X' }], rows: [{ x: 1 }] }],
    });
    const kept = (await loadWorkbook(emojiEnd.buffer)).worksheets.map((ws) => ws.name);
    assert.deepEqual(kept, [`${'b'.repeat(29)}\u{1F600}`], 'a whole emoji within the cap stays');
  });

  /** A one-cell sheet; `formula` puts a formula cell in column A. */
  const sheetNamed = (name: string, formula?: string): XlsxDescriptor['sheets'][number] => ({
    name,
    columns: [{ key: 'x', header: 'X' }],
    rows: [{ x: formula === undefined ? 1 : { formula } }],
  });

  it('gives every sheet a name Excel accepts, unique regardless of case, and reports each rename', async () => {
    const long = 'Umsatz nach Kunde und Region 2026';
    const result = await renderXlsx({
      sheets: [
        sheetNamed("'Quartal'"),
        sheetNamed('Daten'),
        sheetNamed('daten'),
        sheetNamed('A/B'),
        sheetNamed('A B'),
        sheetNamed(`${long} Q1`),
        sheetNamed(`${long} Q2`),
        sheetNamed('Offen'),
      ],
    });

    const wb = await loadWorkbook(result.buffer);
    assert.deepEqual(
      wb.worksheets.map((ws) => ws.name),
      [
        'Quartal',
        'Daten',
        'daten (2)',
        'A B',
        'A B (2)',
        'Umsatz nach Kunde und Region 20',
        'Umsatz nach Kunde und Regio (2)',
        'Offen',
      ],
    );
    assert.deepEqual(result.renamedSheets, [
      { requested: "'Quartal'", written: 'Quartal' },
      { requested: 'daten', written: 'daten (2)' },
      { requested: 'A/B', written: 'A B' },
      { requested: 'A B', written: 'A B (2)' },
      { requested: `${long} Q1`, written: 'Umsatz nach Kunde und Region 20' },
      { requested: `${long} Q2`, written: 'Umsatz nach Kunde und Regio (2)' },
    ]);
  });

  it('reports no renamed sheets when every name is kept', async () => {
    const result = await renderXlsx(descriptor);
    assert.deepEqual(result.renamedSheets, []);
  });

  it('refuses a formula that references a sheet by a name it was not written under', async () => {
    await assert.rejects(
      renderXlsx({ sheets: [sheetNamed('History'), sheetNamed('Summe', 'SUM(History!A2)')] }),
      /formula in sheet "Summe", cell A2 rejected: it references sheet "History", which is written as "History_"; reference it as 'History_'!/,
    );
    // Excel compares sheet names without case, quoted or not.
    await assert.rejects(
      renderXlsx({ sheets: [sheetNamed('History'), sheetNamed('Summe', "SUM('history'!A2)")] }),
      /references sheet "history", which is written as "History_"/,
    );
    // A computed column is checked as well.
    await assert.rejects(
      renderXlsx({
        sheets: [
          sheetNamed('History'),
          {
            name: 'Summe',
            columns: [{ key: 'v', header: 'V', formula: 'History!A{row}*2' }],
            rows: [{}],
          },
        ],
      }),
      /formula in sheet "Summe", computed column "v" rejected: it references sheet "History", which is written as "History_"/,
    );
  });

  it('writes a formula that references a sheet by its written name', async () => {
    const result = await renderXlsx({
      sheets: [
        sheetNamed('History'),
        sheetNamed('Daten'),
        sheetNamed('daten'),
        sheetNamed('Summe', "SUM(History_!A2,'daten (2)'!A2,daten!A2)"),
      ],
    });
    const wb = await loadWorkbook(result.buffer);
    assert.equal(wb.getWorksheet('Summe')?.getCell('A2').formula, "SUM(History_!A2,'daten (2)'!A2,daten!A2)");
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

  it('turns line breaks inside every text field into Word line breaks (#1982)', async () => {
    const result = await renderDocx({
      title: 'Titel eins\nTitel zwei',
      blocks: [
        { type: 'heading', level: 2, text: 'Kopf eins\nKopf zwei' },
        { type: 'paragraph', text: 'Zeile eins\nZeile zwei\r\n\r\nZeile vier' },
        { type: 'bullets', items: ['Punkt eins\nFortsetzung'] },
        { type: 'table', headers: ['Spalte\nA'], rows: [['Zelle\rB']] },
      ],
    });
    const xml = (await unzipToText(result.buffer)).get('word/document.xml') ?? '';

    const texts = [...xml.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1] ?? '');
    assert.ok(
      texts.every((t) => !/[\r\n]/.test(t)),
      'no raw line break may stay inside <w:t>',
    );

    /** Runs of the paragraph that holds `first`: '\n' marks a <w:br/>. */
    const paragraphOf = (first: string): string => {
      const p = [...xml.matchAll(/<w:p>[\s\S]*?<\/w:p>/g)]
        .map((m) => m[0])
        .find((candidate) => candidate.includes(`>${first}</w:t>`));
      assert.ok(p, `paragraph with "${first}" exists`);
      return [...p.matchAll(/<w:br\/>|<w:t[^>]*>([^<]*)<\/w:t>/g)]
        .map((m) => (m[0] === '<w:br/>' ? '\n' : (m[1] ?? '')))
        .join('');
    };
    assert.equal(paragraphOf('Titel eins'), 'Titel eins\nTitel zwei');
    assert.equal(paragraphOf('Kopf eins'), 'Kopf eins\nKopf zwei');
    assert.equal(paragraphOf('Zeile eins'), 'Zeile eins\nZeile zwei\n\nZeile vier');
    assert.equal(paragraphOf('Punkt eins'), 'Punkt eins\nFortsetzung');
    assert.equal(paragraphOf('Spalte'), 'Spalte\nA');
    assert.equal(paragraphOf('Zelle'), 'Zelle\nB');

    // The table header keeps its bold style on every line.
    const header = [...xml.matchAll(/<w:p>[\s\S]*?<\/w:p>/g)]
      .map((m) => m[0])
      .find((p) => p.includes('>Spalte</w:t>'));
    assert.equal(header?.match(/<w:b\/>/g)?.length, 2, 'both header runs are bold');
  });

  it('turns tabs inside text into Word tabs, not raw tab characters', async () => {
    const result = await renderDocx({
      blocks: [
        { type: 'paragraph', text: 'Name\tWert\nZwei\tDrei' },
        { type: 'table', headers: ['Kopf\tA'], rows: [['x']] },
      ],
    });
    const xml = (await unzipToText(result.buffer)).get('word/document.xml') ?? '';
    const texts = [...xml.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1] ?? '');
    assert.ok(texts.every((t) => !t.includes('\t')), 'no raw tab may stay inside <w:t>');

    const runsOf = (first: string): string => {
      const p = [...xml.matchAll(/<w:p>[\s\S]*?<\/w:p>/g)]
        .map((m) => m[0])
        .find((candidate) => candidate.includes(`>${first}</w:t>`));
      assert.ok(p, `paragraph with "${first}" exists`);
      return [...p.matchAll(/<w:br\/>|<w:tab\/>|<w:t[^>]*>([^<]*)<\/w:t>/g)]
        .map((m) => (m[0] === '<w:br/>' ? '\n' : m[0] === '<w:tab/>' ? '\t' : (m[1] ?? '')))
        .join('');
    };
    assert.equal(runsOf('Name'), 'Name\tWert\nZwei\tDrei');
    assert.equal(runsOf('Kopf'), 'Kopf\tA');
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
    // pass drops the dcterms dates and pins the zip mtimes. Advancing a mocked
    // clock between the two renders proves the bytes no longer depend on
    // wall-clock time, so the sha256 cache key in officeService is stable
    // across re-renders.
    t.mock.timers.enable({ apis: ['Date'] });
    try {
      t.mock.timers.setTime(1_700_000_000_000);
      const a = await renderDocx(provenanceDescriptor);
      t.mock.timers.setTime(1_811_000_000_000); // ~3.5 years later
      const b = await renderDocx(provenanceDescriptor);
      assert.ok(a.buffer.equals(b.buffer), 'wall-clock change must not change bytes');
    } finally {
      t.mock.timers.reset();
    }
  });
});

describe('office file timestamps (#1977)', () => {
  const renders: ReadonlyArray<readonly [string, () => Promise<{ buffer: Buffer }>]> = [
    [
      'xlsx',
      () =>
        renderXlsx({
          filename: 'staedte',
          sheets: [
            {
              name: 'Städte',
              columns: [{ key: 'stadt', header: 'Stadt', type: 'text' }],
              rows: [{ stadt: 'Berlin' }],
            },
          ],
        }),
    ],
    [
      'docx',
      () =>
        renderDocx({
          filename: 'bericht',
          title: 'Bericht',
          blocks: [{ type: 'paragraph', text: 'Inhalt.' }],
        }),
    ],
  ];

  for (const [ext, render] of renders) {
    it(`${ext}: every zip entry carries 1980-01-01 00:00, the earliest date the zip format can represent`, async () => {
      // A date before 1980 underflows the 7-bit DOS year field and unzip tools
      // show 2098.
      const stamps = await zipEntryDosStamps((await render()).buffer);
      assert.ok(stamps.size > 0, 'zip has entries');
      for (const [name, stamp] of stamps) {
        assert.deepEqual(stamp, { year: 1980, month: 1, day: 1, hour: 0, minute: 0 }, name);
      }
    });

    it(`${ext}: core.xml carries no created/modified date instead of a made-up one`, async () => {
      // The content-addressed cache forbids the real render time, and any fixed
      // date would show up as a wrong "Created" date in Word/Excel. Both
      // dcterms dates are optional in OPC core properties.
      const core = (await unzipToText((await render()).buffer)).get('docProps/core.xml') ?? '';
      assert.ok(core.includes('<cp:coreProperties'), 'core.xml present');
      assert.doesNotMatch(core, /dcterms:created/);
      assert.doesNotMatch(core, /dcterms:modified/);
      assert.ok(core.includes(PROVENANCE_DESCRIPTION), 'provenance description kept');
    });
  }
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

  it('#1986 — reports the key of every generated file, cache hit included', async () => {
    const persisted: string[] = [];
    const svc = new OfficeService({
      store: new CountingStore(),
      secret: SECRET,
      publicBaseUrl: 'https://bot.example.com',
      tenantId: 'dev',
      signedUrlTtlSec: 60,
      onPersisted: (key) => {
        persisted.push(key);
        return Promise.resolve();
      },
    });
    const descriptor = { sheets: [{ name: 'S', columns: [{ key: 'a', header: 'A' }], rows: [{ a: 1 }] }] };
    await svc.createXlsx(descriptor);
    await svc.createXlsx(descriptor);
    assert.equal(persisted.length, 2);
    assert.equal(persisted[0], persisted[1]);
    assert.match(persisted[0] ?? '', /^documents\/dev\/[0-9a-f]{64}\//);
  });

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

describe('office download disposition (#1963)', () => {
  it('keeps a plain ASCII name as a single quoted filename', () => {
    assert.equal(attachmentDisposition('Offene Posten.xlsx'), 'attachment; filename="Offene Posten.xlsx"');
  });
  it('adds a UTF-8 filename* with an ASCII fallback for umlauts', () => {
    assert.equal(
      attachmentDisposition('Übersicht Größe.xlsx'),
      `attachment; filename="Ubersicht Gro_e.xlsx"; filename*=UTF-8''%C3%9Cbersicht%20Gr%C3%B6%C3%9Fe.xlsx`,
    );
  });
  it('encodes characters above U+00FF instead of putting them in the header', () => {
    assert.equal(
      attachmentDisposition('Umsatz – Q3 €.docx'),
      `attachment; filename="Umsatz _ Q3 _.docx"; filename*=UTF-8''Umsatz%20%E2%80%93%20Q3%20%E2%82%AC.docx`,
    );
  });
  it('percent-encodes characters RFC 8187 does not allow unescaped', () => {
    const value = attachmentDisposition('Bericht (Entwurf) – Ä*.xlsx');
    assert.match(value, /filename\*=UTF-8''Bericht%20%28Entwurf%29%20%E2%80%93%20%C3%84%2A\.xlsx$/);
  });
  it('never lets a quote or backslash reach the quoted fallback', () => {
    assert.equal(
      attachmentDisposition('a"b\\c–.xlsx'),
      `attachment; filename="a_b_c_.xlsx"; filename*=UTF-8''a%22b%5Cc%E2%80%93.xlsx`,
    );
  });
});
