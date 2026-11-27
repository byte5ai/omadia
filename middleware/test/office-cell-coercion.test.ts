/**
 * #1969 — a formula's leading `=` is stripped, so the file holds
 * `<f>SUM(…)</f>`, not `<f>=SUM(…)</f>` (read as `==SUM(…)`).
 *
 * #1971 — typed columns convert only unambiguous values: ISO dates (UTC) and
 * plain decimals. `""` and Odoo's `false` become empty cells; everything else
 * stays text and is reported by address.
 */

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import JSZip from 'jszip';
import { renderXlsx, type XlsxDescriptor } from '@omadia/plugin-office';

async function sheetXml(descriptor: XlsxDescriptor): Promise<string> {
  const result = await renderXlsx(descriptor);
  const zip = await JSZip.loadAsync(result.buffer);
  const xml = await zip.file('xl/worksheets/sheet1.xml')?.async('string');
  assert.ok(xml, 'sheet1.xml exists');
  return xml;
}

describe('#1969 — leading = in formulas', () => {
  it('an inline formula cell is written without the leading =', async () => {
    const xml = await sheetXml({
      sheets: [
        {
          name: 'S',
          columns: [{ key: 'a', header: 'A' }, { key: 'b', header: 'B' }],
          rows: [{ a: 1, b: null }, { a: 2, b: { formula: '=SUM(A2:A3)' } }],
        },
      ],
    } as unknown as XlsxDescriptor);
    assert.ok(xml.includes('<f>SUM(A2:A3)</f>'), xml);
    assert.ok(!xml.includes('<f>='), xml);
  });

  it('a computed column template is written without the leading =', async () => {
    const xml = await sheetXml({
      sheets: [
        {
          name: 'S',
          columns: [
            { key: 'a', header: 'A' },
            { key: 'c', header: 'C', formula: '=A{row}*2' },
          ],
          rows: [{ a: 1 }],
        },
      ],
    } as unknown as XlsxDescriptor);
    assert.ok(xml.includes('<f>A2*2</f>'), xml);
  });

  it('a formula of only "=" is refused', async () => {
    await assert.rejects(
      renderXlsx({
        sheets: [{ name: 'S', columns: [{ key: 'a', header: 'A' }], rows: [{ a: { formula: '=' } }] }],
      } as unknown as XlsxDescriptor),
    );
  });
});

describe('#1971 — strict type coercion', () => {
  const descriptor = {
    sheets: [
      {
        name: 'S',
        columns: [
          { key: 'd', header: 'D', type: 'date' },
          { key: 'n', header: 'N', type: 'number' },
        ],
        rows: [
          { d: '2024-03-12', n: '1234.56' },
          { d: '12.03.2024', n: '1.234,56' },
          { d: 'März 2024', n: '' },
          { d: false, n: false },
          { d: '2024-02-30', n: '0x1F' },
          { d: '2024-03-12T23:30:00', n: 'Infinity' },
        ],
      },
    ],
  } as unknown as XlsxDescriptor;

  it('reports every typed cell kept as text, by address only', async () => {
    const result = await renderXlsx(descriptor);
    const cells = (result.cellsKeptAsText ?? []).map((c) => `${c.cell}:${c.type}`);
    assert.deepEqual(cells, [
      'A3:date',
      'B3:number',
      'A4:date',
      'A6:date',
      'B6:number',
      'B7:number',
    ]);
  });

  it('converts ISO dates in UTC and plain decimals; empty and false become empty', async () => {
    const xml = await sheetXml(descriptor);
    // Row 2: 2024-03-12 → serial 45363; 1234.56 as a number.
    assert.match(xml, /<c r="A2"[^>]*><v>45363<\/v>/);
    assert.match(xml, /<c r="B2"[^>]*><v>1234\.56<\/v>/);
    // Row 4: "" in a number column is an empty cell, not 0.
    assert.ok(!/<c r="B4"[^>]*><v>0<\/v>/.test(xml), xml);
    // Row 5: Odoo false is empty in both typed columns, never FALSE.
    assert.ok(!/<c r="A5"[^>]*t="b"/.test(xml), xml);
    assert.ok(!/<c r="B5"[^>]*t="b"/.test(xml), xml);
    // Row 7: a time without zone is UTC — the day stays 2024-03-12.
    assert.match(xml, /<c r="A7"[^>]*><v>45363\.979166/);
    // "Infinity" and hex stay text (shared strings), never numbers.
    assert.match(xml, /<c r="B7"[^>]*t="s"/);
    assert.match(xml, /<c r="B6"[^>]*t="s"/);
  });
});
