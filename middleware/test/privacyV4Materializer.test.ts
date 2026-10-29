/**
 * Privacy Shield v4 — US6 Materializer tests.
 *
 * The Materializer renders the final answer server-side from the real dataset
 * — real values, including masked-classified columns, for the authenticated
 * user. Includes the end-to-end data path: intern → verb chain → materialize.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { createDatasetStore } from '@omadia/plugin-privacy-guard/dist/v4/datasetStore.js';
import { createShapeClassifier } from '@omadia/plugin-privacy-guard/dist/v4/shapeClassifier.js';
import { buildDigest } from '@omadia/plugin-privacy-guard/dist/v4/digest.js';
import { createVerbEngine } from '@omadia/plugin-privacy-guard/dist/v4/verbs/index.js';
import {
  MAX_CHAT_ROWS,
  MAX_TEXT_CELL_CHARS,
  MaterializerError,
  UNRENDERABLE_CELL,
  htmlToPlainText,
  materialize,
} from '@omadia/plugin-privacy-guard/dist/v4/materializer.js';

const HR_LEAVE = [
  { employee: 'Marvin Vomberg', days: 24 },
  { employee: 'Anna Rüsche', days: 30 },
  { employee: 'Thomas Görres', days: 18 },
];

/** Build RenderColumns from bare field names — label defaults to the field. */
function cols(...fields: string[]): { field: string; label: string }[] {
  return fields.map((field) => ({ field, label: field }));
}

function harness() {
  const classify = createShapeClassifier();
  const store = createDatasetStore({ classify, buildDigest, turnId: 'turn-test' });
  const engine = createVerbEngine({ store, classify });
  return { store, engine };
}

describe('Materializer — formats', () => {
  it('renders a Markdown table with real values', () => {
    const { store } = harness();
    const { datasetId } = store.internToolResult('hr.leave', HR_LEAVE);
    const { text, rowCount } = materialize(store, {
      datasetId,
      columns: cols('employee', 'days'),
      format: 'table',
    });
    assert.equal(rowCount, 3);
    assert.ok(text.includes('| employee | days |'));
    assert.ok(text.includes('Marvin Vomberg'));
    assert.ok(text.includes('Anna Rüsche'));
  });

  it('renders a list', () => {
    const { store } = harness();
    const { datasetId } = store.internToolResult('hr.leave', HR_LEAVE);
    const { text } = materialize(store, {
      datasetId,
      columns: cols('employee', 'days'),
      format: 'list',
    });
    assert.ok(text.includes('- employee: Marvin Vomberg, days: 24'));
  });

  it('renders a nested scalar object as key: value pairs, not "[nested]" (#459)', () => {
    const { store } = harness();
    const { datasetId } = store.internToolResult('strava.stats', [
      {
        label: 'All-Time Ride Totals',
        totals: { count: 1284, distance: 45231000, elevation_gain: 512340 },
      },
    ]);
    const { text } = materialize(store, {
      datasetId,
      columns: cols('label', 'totals'),
      format: 'list',
    });
    assert.ok(!text.includes('[nested]'), 'nested object must not collapse to [nested]');
    assert.ok(text.includes('count: 1284'));
    assert.ok(text.includes('distance: 45231000'));
    assert.ok(text.includes('elevation_gain: 512340'));
  });

  it('renders a scalar', () => {
    const { store, engine } = harness();
    const { datasetId } = store.internToolResult('hr.leave', HR_LEAVE);
    const counted = engine.count(datasetId);
    const { text } = materialize(store, {
      datasetId: counted.datasetId,
      columns: cols('count'),
      format: 'scalar',
    });
    assert.equal(text, '3');
  });

  it('prepends PII-free prose when provided', () => {
    const { store } = harness();
    const { datasetId } = store.internToolResult('hr.leave', HR_LEAVE);
    const { text } = materialize(store, {
      datasetId,
      columns: cols('employee'),
      format: 'list',
      prose: 'Hier ist das Urlaubsranking:',
    });
    assert.ok(text.startsWith('Hier ist das Urlaubsranking:\n\n'));
  });

  it('renders "(no rows)" for an empty dataset', () => {
    const { store } = harness();
    const { datasetId } = store.internToolResult('hr.leave', []);
    const { text, rowCount } = materialize(store, {
      datasetId,
      columns: cols('employee'),
      format: 'table',
    });
    assert.equal(rowCount, 0);
    assert.ok(text.includes('(no rows)'));
  });
});

describe('Materializer — end-to-end data path', () => {
  it('intern → sort → top_n → materialize yields a correct ranked answer', () => {
    const { store, engine } = harness();
    const { datasetId } = store.internToolResult('hr.leave', HR_LEAVE);
    const sorted = engine.sort(datasetId, 'days', 'desc');
    const top = engine.topN(sorted.datasetId, 2, 'days', 'desc');
    const { text } = materialize(store, {
      datasetId: top.datasetId,
      columns: cols('employee', 'days'),
      format: 'table',
    });
    // Real, complete names in correct rank order — Anna (30) before Marvin (24).
    assert.ok(text.indexOf('Anna Rüsche') < text.indexOf('Marvin Vomberg'));
    assert.ok(!text.includes('Thomas Görres'), 'top_n=2 dropped the 3rd row');
  });
});

describe('Materializer — guard rails', () => {
  it('rejects an unknown datasetId', () => {
    const { store } = harness();
    assert.throws(
      () =>
        materialize(store, {
          datasetId: 'ds_missing',
          columns: cols('employee'),
          format: 'table',
        }),
      MaterializerError,
    );
  });

  it('rejects an unknown column', () => {
    const { store } = harness();
    const { datasetId } = store.internToolResult('hr.leave', HR_LEAVE);
    assert.throws(
      () =>
        materialize(store, {
          datasetId,
          columns: cols('salary'),
          format: 'table',
        }),
      MaterializerError,
    );
  });
});

describe('Materializer — maskedValues', () => {
  it('reports the real values rendered from sensitive-masked columns', () => {
    const { store } = harness();
    const { datasetId } = store.internToolResult('hr.leave', HR_LEAVE);
    const { maskedValues } = materialize(store, {
      datasetId,
      columns: cols('employee', 'days'),
      format: 'table',
    });
    // `employee` (human names) is sensitive-masked; `days` (numbers) is
    // safe-cleartext — only the names are reported as masked.
    assert.deepEqual(
      [...maskedValues].sort(),
      ['Anna Rüsche', 'Marvin Vomberg', 'Thomas Görres'],
    );
  });

  it('is empty when only safe-cleartext columns are rendered', () => {
    const { store } = harness();
    const { datasetId } = store.internToolResult('hr.leave', HR_LEAVE);
    const { maskedValues } = materialize(store, {
      datasetId,
      columns: cols('days'),
      format: 'table',
    });
    assert.deepEqual(maskedValues, []);
  });
});

describe('Materializer — display polish', () => {
  it('renders an Odoo many2one [id,"label"] tuple as just the label', () => {
    const { store } = harness();
    const { datasetId } = store.internToolResult('hr.leave', [
      { employee_id: [198, 'Sophie Neumann'], days: 58 },
      { employee_id: [206, 'Moses Otten'], days: 43 },
    ]);
    const { text, maskedValues } = materialize(store, {
      datasetId,
      columns: cols('employee_id', 'days'),
      format: 'table',
    });
    assert.ok(text.includes('Sophie Neumann'));
    assert.ok(!text.includes('[198'), 'the raw [id,name] tuple must not leak');
    // the masked-value highlight tracks the flattened label, not the tuple.
    assert.ok(maskedValues.includes('Sophie Neumann'));
  });

  it('never dumps a nested record array as raw JSON into a cell', () => {
    const { store } = harness();
    // Two record-arrays => the store does NOT expand (ambiguous), so a nested
    // array can still reach the cell renderer. It must render a compact marker
    // rather than a raw JSON blob (the unreadable timesheet rendering).
    const { datasetId } = store.internToolResult('x', [
      { id: 1, a: [{ inner: 'x1' }], b: [{ inner: 'x2' }] },
    ]);
    const { text } = materialize(store, {
      datasetId,
      columns: cols('id', 'a'),
      format: 'table',
    });
    assert.ok(!text.includes('"inner"'), 'no raw JSON keys are emitted');
    assert.ok(!text.includes('x1'), 'nested record values are not dumped raw');
    assert.ok(text.includes('[1 records]'), 'shows a compact structure-only marker');
  });

  it('joins a scalar array into a readable cell', () => {
    const { store } = harness();
    const { datasetId } = store.internToolResult('x', [
      { id: 1, tags: ['urgent', 'hr', 'q2'] },
    ]);
    const { text } = materialize(store, {
      datasetId,
      columns: cols('tags'),
      format: 'table',
    });
    assert.ok(text.includes('urgent, hr, q2'));
  });

  it('renders a "summary + detail" tool result as a per-record table', () => {
    const { store } = harness();
    // The real timesheet shape: one summary object wrapping the per-employee
    // detail array. The store promotes it to one row per employee.
    const { datasetId, digest } = store.internToolResult(
      'query_odoo_timesheet_analyzer',
      {
        jahr: 2026,
        kw: 22,
        abweichungen_pro_ma: [
          { employee_name: 'Alexandra Hochhaus', delta_hours: -40 },
          { employee_name: 'Christian Köhler', delta_hours: -39.87 },
        ],
      },
    );
    // The names are masked from the LLM's digest...
    assert.ok(!JSON.stringify(digest).includes('Hochhaus'));
    // ...but rendered as real values for the authorised user, as a real table.
    const { text, rowCount } = materialize(store, {
      datasetId,
      columns: cols('employee_name', 'delta_hours', 'kw'),
      format: 'table',
    });
    assert.equal(rowCount, 2);
    assert.ok(text.includes('Alexandra Hochhaus'));
    assert.ok(text.includes('Christian Köhler'));
    assert.ok(!text.includes('"employee_name"'), 'no raw JSON blob');
  });

  it('uses each column label as the table header', () => {
    const { store } = harness();
    const { datasetId } = store.internToolResult('hr.leave', HR_LEAVE);
    const { text } = materialize(store, {
      datasetId,
      columns: [
        { field: 'employee', label: 'Mitarbeiter' },
        { field: 'days', label: 'Summe Tage' },
      ],
      format: 'table',
    });
    assert.ok(text.includes('| Mitarbeiter | Summe Tage |'));
  });

  it('prepends a 1-based rank column when rankColumn is set', () => {
    const { store, engine } = harness();
    const { datasetId } = store.internToolResult('hr.leave', HR_LEAVE);
    const sorted = engine.sort(datasetId, 'days', 'desc');
    const { text } = materialize(store, {
      datasetId: sorted.datasetId,
      columns: [{ field: 'employee', label: 'Mitarbeiter' }],
      format: 'table',
      rankColumn: 'Rang',
    });
    assert.ok(text.includes('| Rang | Mitarbeiter |'));
    // First data row is rank 1 — Anna Rüsche (30 days, the max).
    assert.ok(text.split('\n')[2]?.startsWith('| 1 | Anna Rüsche'));
  });
});

// ---------------------------------------------------------------------------
// Row cap — a 953-row table once took a whole Teams turn down ("Broken
// Markdown" after the channel clipped it at 25k chars). The materializer now
// stops at MAX_CHAT_ROWS and says exactly how many rows it left out.
// ---------------------------------------------------------------------------

/** `n` rows with a masked name and a safe number. */
function manyRows(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    employee: `Person Nummer ${String(i + 1)}`,
    days: i + 1,
  }));
}

describe('Materializer — chat row cap', () => {
  it('renders every row and no footer when the dataset fits', () => {
    const { store } = harness();
    const { datasetId } = store.internToolResult('x', manyRows(MAX_CHAT_ROWS));
    const r = materialize(store, { datasetId, columns: cols('employee', 'days'), format: 'table' });
    assert.equal(r.rowCount, MAX_CHAT_ROWS);
    assert.equal(r.renderedRowCount, MAX_CHAT_ROWS);
    assert.ok(!r.text.includes('weitere Zeile'));
    assert.equal(r.structuredTable?.rows.length, MAX_CHAT_ROWS);
  });

  it('caps a table at MAX_CHAT_ROWS and names the omitted count', () => {
    const { store } = harness();
    const { datasetId } = store.internToolResult('x', manyRows(953));
    const r = materialize(
      store,
      { datasetId, columns: cols('employee', 'days'), format: 'table' },
      { fileExportAvailable: true },
    );
    assert.equal(r.rowCount, 953, 'rowCount stays the number the answer is about');
    assert.equal(r.renderedRowCount, MAX_CHAT_ROWS);
    const lines = r.text.split('\n');
    // header + separator + 50 rows, then a blank line and the footer.
    assert.equal(lines.filter((l) => l.startsWith('| ')).length, MAX_CHAT_ROWS + 2);
    assert.ok(r.text.includes(`… ${String(953 - MAX_CHAT_ROWS)} weitere Zeilen nicht angezeigt (${String(MAX_CHAT_ROWS)} von 953)`));
    assert.ok(r.text.includes('Excel'));
    assert.ok(r.text.includes('Person Nummer 50'));
    assert.ok(!r.text.includes('Person Nummer 51'));
    // The structured (canvas) table is capped the same way.
    assert.equal(r.structuredTable?.rows.length, MAX_CHAT_ROWS);
  });

  it('offers no Excel file when no export tool is offered (#1559)', () => {
    const { store } = harness();
    const { datasetId } = store.internToolResult('x', manyRows(80));
    const r = materialize(store, { datasetId, columns: cols('employee'), format: 'table' });
    assert.ok(r.text.includes('… 30 weitere Zeilen nicht angezeigt (50 von 80)._'), r.text);
    assert.ok(!r.text.includes('Excel'), 'the footer promised a file nobody can build');
  });

  it('caps a list the same way', () => {
    const { store } = harness();
    const { datasetId } = store.internToolResult('x', manyRows(51));
    const r = materialize(store, { datasetId, columns: cols('employee'), format: 'list' });
    assert.equal(r.renderedRowCount, 50);
    assert.equal(r.text.split('\n').filter((l) => l.startsWith('- ')).length, 50);
    assert.ok(r.text.includes('… 1 weitere Zeile nicht angezeigt (50 von 51)'), 'singular form');
  });

  it('never caps a scalar', () => {
    const { store, engine } = harness();
    const { datasetId } = store.internToolResult('x', manyRows(200));
    const c = engine.count(datasetId);
    const r = materialize(store, { datasetId: c.datasetId, columns: cols('count'), format: 'scalar' }, { maxRows: 1 });
    assert.equal(r.text, '200');
  });

  it('reports only the rendered masked values, not the omitted ones', () => {
    const { store } = harness();
    const { datasetId } = store.internToolResult('x', manyRows(60));
    const r = materialize(store, { datasetId, columns: cols('employee'), format: 'table' }, { maxRows: 10 });
    assert.equal(r.maskedValues.length, 10);
    assert.ok(!r.maskedValues.includes('Person Nummer 11'));
  });

  it('honours an explicit maxRows and rejects a non-positive one', () => {
    const { store } = harness();
    const { datasetId } = store.internToolResult('x', manyRows(5));
    const r = materialize(store, { datasetId, columns: cols('days'), format: 'table' }, { maxRows: 2 });
    assert.equal(r.renderedRowCount, 2);
    assert.throws(
      () => materialize(store, { datasetId, columns: cols('days'), format: 'table' }, { maxRows: 0 }),
      MaterializerError,
    );
  });
});

// ---------------------------------------------------------------------------
// #1542 — nested objects (a Confluence page) render readably for the user;
// what cannot be rendered says so instead of an opaque `[nested]`.
// ---------------------------------------------------------------------------

const PAGE_HTML =
  '<h2>Kontaktliste Testteam</h2><p>Jonas Weber &ndash; jonas.weber@example.com</p>' +
  '<ul><li>Telefon: +49 30 1234567</li><li>Raum&nbsp;4.12 &amp; 4.13</li></ul>' +
  '<p>Stand: Oktober<br/>gepflegt von HR — bitte aktuell halten, damit alle Kontakte stimmen.</p>';

function confluencePage() {
  return {
    id: '98765',
    title: 'Kontaktliste Testteam',
    space: { key: 'ENG', name: 'Engineering', _expandable: { homepage: '/rest/api/x' } },
    version: { number: 3, when: '2026-10-01T10:00:00Z', by: { displayName: 'Jonas Weber' } },
    body: {
      view: { value: PAGE_HTML, representation: 'view', _expandable: { webresource: '' } },
      _expandable: { storage: '/rest/api/content/98765?expand=body.storage' },
    },
  };
}

describe('Materializer — nested objects (#1542)', () => {
  it('renders a page body as plain text, version and space by their display fields', () => {
    const { store } = harness();
    const { datasetId } = store.internToolResult('confluence_get_page', [confluencePage()]);
    const r = materialize(store, {
      datasetId,
      columns: [
        { field: 'title', label: 'Titel' },
        { field: 'space', label: 'Space' },
        { field: 'version', label: 'Version' },
        { field: 'body', label: 'Inhalt (wörtlich)' },
      ],
      format: 'table',
    });
    const cells = r.structuredTable?.rows[0]?.cells ?? {};
    assert.equal(cells.space, 'ENG – Engineering');
    assert.equal(cells.version, '3');
    const body = String(cells.body);
    assert.ok(body.includes('Kontaktliste Testteam\nJonas Weber – jonas.weber@example.com'), body);
    assert.ok(body.includes('• Telefon: +49 30 1234567'), body);
    assert.ok(body.includes('Raum 4.12 & 4.13'), body);
    assert.ok(!body.includes('<'), 'no HTML tag reaches the cell');
    assert.ok(!r.text.includes('_expandable'), 'API bookkeeping keys are never rendered');
    assert.ok(!r.text.includes('[nested]'));
    assert.deepEqual(r.unrenderedColumns, []);
    assert.ok(!r.text.includes('nicht darstellen'), 'no "not renderable" note when all rendered');
  });

  it('caps a long text cell with an ellipsis', () => {
    const { store } = harness();
    const long = `<p>${'Absatz mit Inhalt. '.repeat(200)}</p>`;
    const { datasetId } = store.internToolResult('confluence_get_page', [
      { id: 1, body: { storage: { value: long, representation: 'storage' } } },
    ]);
    const r = materialize(store, { datasetId, columns: cols('body'), format: 'table' });
    const body = String(r.structuredTable?.rows[0]?.cells.body);
    assert.ok(body.endsWith(' …'), body.slice(-20));
    assert.ok(body.length <= MAX_TEXT_CELL_CHARS + 2);
  });

  it('marks an unrenderable structure explicitly, reports its column and tells the user', () => {
    const { store } = harness();
    const deep = { a: { b: { c: { d: 1 } } }, e: { f: { g: 2 } }, h: { i: { j: 3 } } };
    const { datasetId } = store.internToolResult('x', [{ id: 1, blob: deep }]);
    const r = materialize(store, {
      datasetId,
      columns: [cols('id')[0]!, { field: 'blob', label: 'Rohdaten' }],
      format: 'table',
    });
    assert.ok(r.text.includes(UNRENDERABLE_CELL), r.text);
    assert.ok(!r.text.includes('[nested]'));
    assert.deepEqual(r.unrenderedColumns, ['Rohdaten']);
    assert.ok(r.text.includes('der Spalte „Rohdaten"'), r.text);
    assert.ok(r.text.includes('Bypass'), 'the user learns how to get the content');
  });

  it('converts HTML to text: breaks kept, entities decoded, unknown entities left alone', () => {
    assert.equal(
      htmlToPlainText('<p>a&amp;b</p><p>c&#228;&#x00FC; &toString; &bogus;</p>'),
      'a&b\ncäü &toString; &bogus;',
    );
  });
});
