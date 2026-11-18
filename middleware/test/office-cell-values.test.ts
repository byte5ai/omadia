import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import ExcelJS from 'exceljs';
import {
  renderXlsx,
  OfficeRenderError,
  XlsxToolInputSchema,
  type XlsxDescriptor,
} from '@omadia/plugin-office';

// renderXlsx is exported, so a caller can hand it a descriptor that never went
// through the input schema. exceljs decides what a cell is from the shape of
// the value, not from our types: an object with a truthy `formula` or
// `sharedFormula` becomes a formula (a `result` next to it becomes the cached
// value), and `{ text, hyperlink }` becomes an external link. So the renderer
// hands exceljs only text, numbers, booleans, null and `{ formula }` with a
// formula string, and refuses everything else before any byte is written.

/** One sheet with one column `a`, header and rows taken as given and cast past
 *  the type, the way a direct caller could. */
function sheetWith(rows: readonly unknown[], header: unknown = 'A'): XlsxDescriptor {
  return { sheets: [{ name: 'S', columns: [{ key: 'a', header }], rows }] } as unknown as XlsxDescriptor;
}

/** Rendering fails with an OfficeRenderError whose message matches `message`,
 *  so no workbook comes out. */
async function assertRefused(descriptor: XlsxDescriptor, message: RegExp): Promise<void> {
  await assert.rejects(renderXlsx(descriptor), (err: unknown) => {
    assert.ok(err instanceof OfficeRenderError, `expected OfficeRenderError, got ${String(err)}`);
    assert.match(err.message, message);
    return true;
  });
}

/** The first worksheet of a rendered workbook, read back with ExcelJS. */
async function firstSheet(descriptor: XlsxDescriptor): Promise<ExcelJS.Worksheet> {
  const result = await renderXlsx(descriptor);
  const wb = new ExcelJS.Workbook();
  // exceljs types `load` against an older Buffer; the bytes are the same.
  await wb.xlsx.load(result.buffer as unknown as ArrayBuffer);
  const ws = wb.worksheets[0];
  assert.ok(ws, 'the workbook has a worksheet');
  return ws;
}

describe('office xlsx renderer — only plain cell values reach exceljs', () => {
  const notCellValues: ReadonlyArray<readonly [value: unknown, why: string]> = [
    [{ sharedFormula: 'A2', result: 999 }, 'a shared formula with a cached value'],
    [{ formula: ['1+1'], result: 999 }, 'a formula that is not a string, with a cached value'],
    [
      { formula: ['WEBSERVICE("https://example.invalid/")'] },
      'a formula that is not a string, which the formula policy would never read',
    ],
    [{ text: 'x', hyperlink: 'https://example.invalid/?q=x' }, 'a link'],
    [{ richText: [{ text: 'x' }] }, 'rich text'],
    [{ error: '#N/A' }, 'an error value'],
    [{ formula: '' }, 'an empty formula'],
    [new Date(0), 'a date object'],
    [['x'], 'an array'],
  ];

  for (const [value, why] of notCellValues) {
    it(`refuses ${why} as a cell value`, async () => {
      // A2 holds a valid formula cell, so the refused value sits in A3.
      const descriptor = sheetWith([{ a: { formula: '1+1' } }, { a: value }]);
      assert.equal(XlsxToolInputSchema.safeParse(descriptor).success, false, 'the input schema refuses it too');
      await assertRefused(descriptor, /^value in sheet "S", cell A3 rejected: /);
    });
  }

  it('refuses a column header that is not text', async () => {
    // exceljs writes a header into row 1 like any other cell value, and an
    // array header into several rows.
    const headers: readonly unknown[] = [
      { formula: 'WEBSERVICE("https://example.invalid/")', result: 999 },
      { text: 'x', hyperlink: 'https://example.invalid/' },
      ['A', { formula: '1+1', result: 999 }],
    ];
    for (const header of headers) {
      await assertRefused(sheetWith([{ a: 1 }], header), /^header in sheet "S", column "a" rejected: /);
    }
  });

  it('refuses a computed column whose formula is not text', async () => {
    const descriptor = {
      sheets: [
        {
          name: 'S',
          columns: [
            { key: 'a', header: 'A' },
            { key: 'calc', header: 'Calc', formula: ['WEBSERVICE("https://example.invalid/")'] },
          ],
          rows: [{ a: 1 }],
        },
      ],
    } as unknown as XlsxDescriptor;
    await assertRefused(descriptor, /^formula in sheet "S", computed column "calc" rejected: /);
  });

  it("reads only a row's own keys", async () => {
    // A column key may be the name of a property every object inherits. A row
    // without that key leaves the cell empty; the prototype is never read.
    const ws = await firstSheet({
      sheets: [
        {
          name: 'S',
          columns: [
            { key: 'constructor', header: 'C' },
            { key: 'toString', header: 'T' },
          ],
          rows: [{}, { constructor: 'x', toString: 'y' }],
        },
      ],
    });
    assert.deepEqual(
      ['A2', 'B2', 'A3', 'B3'].map((address) => ws.getCell(address).value),
      [null, null, 'x', 'y'],
    );
  });

  it('stores a string that starts with = as text, not as a formula', async () => {
    // Only `{ formula }` makes a formula, and only that goes through the
    // formula policy. A string stays data whatever it starts with; an exceljs
    // upgrade that read it as a formula would hand the client an unchecked one.
    const text = '=WEBSERVICE("https://example.invalid/")';
    const ws = await firstSheet(sheetWith([{ a: text }]));
    assert.equal(ws.getCell('A2').value, text);
  });
});
