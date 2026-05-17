import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { renderRoutineTemplate } from '../src/plugins/routines/routineTemplateRenderer.js';
import type { RoutineOutputTemplate } from '../src/plugins/routines/routineOutputTemplate.js';

function run(opts: {
  template: RoutineOutputTemplate;
  raw?: Record<string, unknown>;
  slots?: Record<string, string>;
  locale?: string;
  currency?: string;
}): string {
  const rawToolResults = new Map<string, unknown>(
    Object.entries(opts.raw ?? {}),
  );
  const r = renderRoutineTemplate({
    template: opts.template,
    rawToolResults,
    slots: opts.slots ?? {},
    ...(opts.locale ? { locale: opts.locale } : {}),
    ...(opts.currency ? { currency: opts.currency } : {}),
  });
  if (!r.ok) {
    throw new Error(`render failed: ${r.reason}`);
  }
  if (r.format !== 'markdown') {
    throw new Error(`expected markdown result, got ${r.format}`);
  }
  return r.text;
}

function runAdaptive(opts: {
  template: RoutineOutputTemplate;
  raw?: Record<string, unknown>;
  slots?: Record<string, string>;
  locale?: string;
  currency?: string;
}): readonly unknown[] {
  const rawToolResults = new Map<string, unknown>(
    Object.entries(opts.raw ?? {}),
  );
  const r = renderRoutineTemplate({
    template: opts.template,
    rawToolResults,
    slots: opts.slots ?? {},
    ...(opts.locale ? { locale: opts.locale } : {}),
    ...(opts.currency ? { currency: opts.currency } : {}),
  });
  if (!r.ok) {
    throw new Error(`render failed: ${r.reason}`);
  }
  if (r.format !== 'adaptive-card') {
    throw new Error(`expected adaptive-card result, got ${r.format}`);
  }
  return r.items;
}

describe('renderRoutineTemplate — format gating', () => {
  it('rejects html format until a real consumer needs it', () => {
    const r = renderRoutineTemplate({
      template: {
        format: 'html',
        sections: [{ kind: 'static-markdown', text: 'hi' }],
      },
      rawToolResults: new Map(),
      slots: {},
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /'html' is not yet supported/);
  });

  it('accepts markdown format and tags the result with format=markdown', () => {
    const r = renderRoutineTemplate({
      template: { format: 'markdown', sections: [] },
      rawToolResults: new Map(),
      slots: {},
    });
    assert.equal(r.ok, true);
    if (r.ok && r.format === 'markdown') assert.equal(r.text, '');
    else assert.fail('expected markdown result');
  });

  it('accepts adaptive-card format and tags the result with format=adaptive-card', () => {
    const r = renderRoutineTemplate({
      template: { format: 'adaptive-card', sections: [] },
      rawToolResults: new Map(),
      slots: {},
    });
    assert.equal(r.ok, true);
    if (r.ok && r.format === 'adaptive-card') {
      assert.deepEqual(r.items, []);
    } else {
      assert.fail('expected adaptive-card result');
    }
  });
});

describe('renderRoutineTemplate — narrative-slot', () => {
  it('renders slot text verbatim', () => {
    const out = run({
      template: {
        format: 'markdown',
        sections: [{ kind: 'narrative-slot', id: 'intro' }],
      },
      slots: { intro: 'Heute, 15. Mai 2026, sind 3 Mitarbeiter abwesend.' },
    });
    assert.equal(out, 'Heute, 15. Mai 2026, sind 3 Mitarbeiter abwesend.');
  });

  it('skips empty / whitespace-only slots silently', () => {
    const out = run({
      template: {
        format: 'markdown',
        sections: [
          { kind: 'narrative-slot', id: 'intro' },
          { kind: 'static-markdown', text: 'footer' },
        ],
      },
      slots: { intro: '   ' },
    });
    assert.equal(out, 'footer');
  });

  it('skips a slot when the id is absent from the slots map', () => {
    const out = run({
      template: {
        format: 'markdown',
        sections: [{ kind: 'narrative-slot', id: 'missing' }],
      },
      slots: {},
    });
    assert.equal(out, '');
  });
});

describe('renderRoutineTemplate — static-markdown', () => {
  it('renders verbatim', () => {
    const out = run({
      template: {
        format: 'markdown',
        sections: [{ kind: 'static-markdown', text: '_Quelle: Odoo HR_' }],
      },
    });
    assert.equal(out, '_Quelle: Odoo HR_');
  });
});

describe('renderRoutineTemplate — data-table', () => {
  const TABLE: RoutineOutputTemplate = {
    format: 'markdown',
    sections: [
      {
        kind: 'data-table',
        sourceTool: 'query_odoo_hr',
        sourcePath: 'absences',
        title: 'Abwesenheiten',
        columns: [
          { label: 'Mitarbeiter', field: 'name' },
          { label: 'Abteilung', field: 'department' },
          { label: 'Bis', field: 'until', format: 'date' },
        ],
      },
    ],
  };

  it('renders a markdown table from structured rows', () => {
    const out = run({
      template: TABLE,
      raw: {
        query_odoo_hr: {
          absences: [
            { name: 'Anna Müller', department: 'PHP', until: '2026-05-15' },
            { name: 'Ben Lee', department: 'Ops', until: '2026-05-25' },
          ],
        },
      },
    });
    assert.match(out, /## Abwesenheiten/);
    assert.match(out, /\| Mitarbeiter \| Abteilung \| Bis \|/);
    assert.match(out, /\| --- \| --- \| --- \|/);
    assert.match(out, /\| Anna Müller \| PHP \| 15\.05\.2026 \|/);
    assert.match(out, /\| Ben Lee \| Ops \| 25\.05\.2026 \|/);
  });

  it('parses string-captured JSON (typical tool-handler return)', () => {
    const out = run({
      template: TABLE,
      raw: {
        query_odoo_hr: '{"absences":[{"name":"Anna","department":"PHP","until":"2026-05-15"}]}',
      },
    });
    assert.match(out, /\| Anna \| PHP \| 15\.05\.2026 \|/);
  });

  it('extracts a JSON block embedded in surrounding markdown', () => {
    const out = run({
      template: TABLE,
      raw: {
        query_odoo_hr: 'Tool output:\n```json\n{"absences":[{"name":"Carla","department":"QA","until":"2026-06-01"}]}\n```\nEnde.',
      },
    });
    assert.match(out, /\| Carla \| QA \| 01\.06\.2026 \|/);
  });

  it('renders emptyText when the source array is empty', () => {
    const out = run({
      template: {
        format: 'markdown',
        sections: [
          {
            kind: 'data-table',
            sourceTool: 'query_odoo_hr',
            sourcePath: 'absences',
            title: 'Abwesenheiten',
            emptyText: 'Heute keine Einträge.',
            columns: [{ label: 'X', field: 'x' }],
          },
        ],
      },
      raw: { query_odoo_hr: { absences: [] } },
    });
    assert.equal(out, '## Abwesenheiten\n\nHeute keine Einträge.');
  });

  it('falls back to em-dash placeholder when emptyText is omitted', () => {
    const out = run({
      template: {
        format: 'markdown',
        sections: [
          {
            kind: 'data-table',
            sourceTool: 'query_odoo_hr',
            sourcePath: 'absences',
            columns: [{ label: 'X', field: 'x' }],
          },
        ],
      },
      raw: { query_odoo_hr: { absences: [] } },
    });
    assert.equal(out, '—');
  });

  it('renders emptyText when the tool was never captured', () => {
    const out = run({
      template: {
        format: 'markdown',
        sections: [
          {
            kind: 'data-table',
            sourceTool: 'query_odoo_hr',
            sourcePath: 'absences',
            emptyText: 'Tool nicht gelaufen.',
            columns: [{ label: 'X', field: 'x' }],
          },
        ],
      },
      raw: {},
    });
    assert.equal(out, 'Tool nicht gelaufen.');
  });

  it('renders emptyText when the captured value is unparseable', () => {
    const out = run({
      template: {
        format: 'markdown',
        sections: [
          {
            kind: 'data-table',
            sourceTool: 'query_odoo_hr',
            sourcePath: 'absences',
            emptyText: 'Daten unleserlich.',
            columns: [{ label: 'X', field: 'x' }],
          },
        ],
      },
      raw: { query_odoo_hr: 'not json at all' },
    });
    assert.equal(out, 'Daten unleserlich.');
  });

  it('uses the whole payload as rows when sourcePath is omitted', () => {
    const out = run({
      template: {
        format: 'markdown',
        sections: [
          {
            kind: 'data-table',
            sourceTool: 'list_tasks',
            columns: [{ label: 'Title', field: 'title' }],
          },
        ],
      },
      raw: { list_tasks: [{ title: 'A' }, { title: 'B' }] },
    });
    assert.match(out, /\| A \|/);
    assert.match(out, /\| B \|/);
  });

  it('uses titleSlot value over literal title when both are present', () => {
    const out = run({
      template: {
        format: 'markdown',
        sections: [
          {
            kind: 'data-table',
            sourceTool: 't',
            sourcePath: 'rows',
            title: 'Static Title',
            titleSlot: 'dyn_title',
            columns: [{ label: 'X', field: 'x' }],
          },
        ],
      },
      raw: { t: { rows: [{ x: 1 }] } },
      slots: { dyn_title: 'Dynamic Title' },
    });
    assert.match(out, /## Dynamic Title/);
    assert.doesNotMatch(out, /Static Title/);
  });

  it('drops the title entirely when titleSlot resolves to empty', () => {
    const out = run({
      template: {
        format: 'markdown',
        sections: [
          {
            kind: 'data-table',
            sourceTool: 't',
            sourcePath: 'rows',
            titleSlot: 'dyn',
            columns: [{ label: 'X', field: 'x' }],
          },
        ],
      },
      raw: { t: { rows: [{ x: 1 }] } },
      slots: { dyn: '   ' },
    });
    assert.doesNotMatch(out, /^## /m);
    assert.match(out, /\| 1 \|/);
  });

  it('escapes pipe characters in cell values', () => {
    const out = run({
      template: {
        format: 'markdown',
        sections: [
          {
            kind: 'data-table',
            sourceTool: 't',
            sourcePath: 'rows',
            columns: [{ label: 'Path', field: 'path' }],
          },
        ],
      },
      raw: { t: { rows: [{ path: 'a|b|c' }] } },
    });
    assert.match(out, /\| a\\\|b\\\|c \|/);
  });

  it('collapses embedded newlines in cells to spaces', () => {
    const out = run({
      template: {
        format: 'markdown',
        sections: [
          {
            kind: 'data-table',
            sourceTool: 't',
            sourcePath: 'rows',
            columns: [{ label: 'Note', field: 'note' }],
          },
        ],
      },
      raw: { t: { rows: [{ note: 'line1\nline2' }] } },
    });
    assert.match(out, /\| line1 line2 \|/);
  });

  it('formats currency columns using locale + currency', () => {
    const out = run({
      template: {
        format: 'markdown',
        sections: [
          {
            kind: 'data-table',
            sourceTool: 't',
            sourcePath: 'rows',
            columns: [{ label: 'Preis', field: 'price', format: 'currency' }],
          },
        ],
      },
      raw: { t: { rows: [{ price: 1234.5 }] } },
      locale: 'de-DE',
      currency: 'EUR',
    });
    // Intl formats with non-breaking spaces — match loosely.
    assert.match(out, /1\.234,50/);
    assert.match(out, /€/);
  });

  it('renders unknown column fields as empty cells', () => {
    const out = run({
      template: {
        format: 'markdown',
        sections: [
          {
            kind: 'data-table',
            sourceTool: 't',
            sourcePath: 'rows',
            columns: [
              { label: 'Have', field: 'have' },
              { label: 'Miss', field: 'absent' },
            ],
          },
        ],
      },
      raw: { t: { rows: [{ have: 'yes' }] } },
    });
    assert.match(out, /\| yes \|  \|/);
  });

  it('groupBy splits rows into sub-sections in first-seen order', () => {
    const out = run({
      template: {
        format: 'markdown',
        sections: [
          {
            kind: 'data-table',
            sourceTool: 't',
            sourcePath: 'rows',
            groupBy: 'type',
            columns: [{ label: 'Name', field: 'name' }],
          },
        ],
      },
      raw: {
        t: {
          rows: [
            { type: 'Urlaub', name: 'A' },
            { type: 'Krank', name: 'B' },
            { type: 'Urlaub', name: 'C' },
          ],
        },
      },
    });
    const idxUrlaub = out.indexOf('### Urlaub');
    const idxKrank = out.indexOf('### Krank');
    assert.ok(idxUrlaub >= 0);
    assert.ok(idxKrank > idxUrlaub, 'group order must be first-seen');
    // Both A and C land in the Urlaub bucket
    const urlaubBlock = out.slice(idxUrlaub, idxKrank);
    assert.match(urlaubBlock, /\| A \|/);
    assert.match(urlaubBlock, /\| C \|/);
  });
});

describe('renderRoutineTemplate — data-list', () => {
  it('renders bullets via Mustache interpolation', () => {
    const out = run({
      template: {
        format: 'markdown',
        sections: [
          {
            kind: 'data-list',
            sourceTool: 't',
            sourcePath: 'items',
            itemTemplate: '{{ name }} ({{ count }})',
          },
        ],
      },
      raw: { t: { items: [{ name: 'A', count: 3 }, { name: 'B', count: 1 }] } },
    });
    assert.equal(out, '- A (3)\n- B (1)');
  });

  it('substitutes empty string for unknown fields', () => {
    const out = run({
      template: {
        format: 'markdown',
        sections: [
          {
            kind: 'data-list',
            sourceTool: 't',
            sourcePath: 'items',
            itemTemplate: '{{ name }}-{{ unknown }}',
          },
        ],
      },
      raw: { t: { items: [{ name: 'Alice' }] } },
    });
    assert.equal(out, '- Alice-');
  });

  it('renders emptyText when items is empty', () => {
    const out = run({
      template: {
        format: 'markdown',
        sections: [
          {
            kind: 'data-list',
            sourceTool: 't',
            sourcePath: 'items',
            itemTemplate: '{{ x }}',
            emptyText: 'Nichts dabei.',
          },
        ],
      },
      raw: { t: { items: [] } },
    });
    assert.equal(out, 'Nichts dabei.');
  });
});

describe('renderRoutineTemplate — section composition', () => {
  it('composes sections in template order, separated by blank lines', () => {
    const out = run({
      template: {
        format: 'markdown',
        sections: [
          { kind: 'narrative-slot', id: 'intro' },
          {
            kind: 'data-table',
            sourceTool: 't',
            sourcePath: 'rows',
            title: 'Daten',
            columns: [{ label: 'X', field: 'x' }],
          },
          { kind: 'narrative-slot', id: 'summary' },
          { kind: 'static-markdown', text: '_footer_' },
        ],
      },
      raw: { t: { rows: [{ x: 1 }] } },
      slots: { intro: 'Hallo.', summary: 'Tschüss.' },
    });
    // Each section appears in order; we don't assert on splitter
    // since titles inside data sections legitimately introduce
    // their own `\n\n` separator between header and body.
    const introIdx = out.indexOf('Hallo.');
    const tableIdx = out.indexOf('## Daten');
    const summaryIdx = out.indexOf('Tschüss.');
    const footerIdx = out.indexOf('_footer_');
    assert.ok(introIdx >= 0, 'intro present');
    assert.ok(tableIdx > introIdx, 'table after intro');
    assert.ok(summaryIdx > tableIdx, 'summary after table');
    assert.ok(footerIdx > summaryIdx, 'footer after summary');
    // Adjacent sections are separated by exactly one blank line.
    assert.match(out, /Hallo\.\n\n## Daten/);
    assert.match(out, /\n\nTschüss\.\n\n_footer_$/);
  });

  it('returns empty string when every section collapses to empty', () => {
    const out = run({
      template: {
        format: 'markdown',
        sections: [
          { kind: 'narrative-slot', id: 'missing' },
          { kind: 'static-markdown', text: '   ' },
        ],
      },
    });
    assert.equal(out, '');
  });
});

/**
 * Phase C.6 — Adaptive Card body items.
 *
 * Verifies the parallel `format: 'adaptive-card'` render path produces
 * Adaptive Card 1.5 body items per template section kind. Each item is
 * a plain JSON object the channel adapter embeds directly into the
 * card frame.
 */
describe('renderRoutineTemplate — adaptive-card narrative + static', () => {
  it('renders narrative-slot as a wrap TextBlock', () => {
    const items = runAdaptive({
      template: {
        format: 'adaptive-card',
        sections: [{ kind: 'narrative-slot', id: 'intro' }],
      },
      slots: { intro: 'Hallo.' },
    });
    assert.deepEqual(items, [
      { type: 'TextBlock', text: 'Hallo.', wrap: true },
    ]);
  });

  it('skips empty / whitespace narrative slots silently', () => {
    const items = runAdaptive({
      template: {
        format: 'adaptive-card',
        sections: [
          { kind: 'narrative-slot', id: 'intro' },
          { kind: 'static-markdown', text: 'footer' },
        ],
      },
      slots: { intro: '   ' },
    });
    assert.equal(items.length, 1);
    assert.deepEqual(items[0], { type: 'TextBlock', text: 'footer', wrap: true });
  });

  it('renders static-markdown as a wrap TextBlock verbatim', () => {
    const items = runAdaptive({
      template: {
        format: 'adaptive-card',
        sections: [{ kind: 'static-markdown', text: '_Quelle: Odoo_' }],
      },
    });
    assert.deepEqual(items, [
      { type: 'TextBlock', text: '_Quelle: Odoo_', wrap: true },
    ]);
  });
});

describe('renderRoutineTemplate — adaptive-card data-table', () => {
  it('renders a title TextBlock + Table with header row + body rows', () => {
    const items = runAdaptive({
      template: {
        format: 'adaptive-card',
        sections: [
          {
            kind: 'data-table',
            sourceTool: 'query_odoo_hr',
            sourcePath: 'absences',
            title: 'Abwesenheiten',
            columns: [
              { label: 'Mitarbeiter', field: 'name' },
              { label: 'Abteilung', field: 'department' },
            ],
          },
        ],
      },
      raw: {
        query_odoo_hr: {
          absences: [
            { name: 'Anna Müller', department: 'PHP' },
            { name: 'Ben Lee', department: 'Ops' },
          ],
        },
      },
    });
    assert.equal(items.length, 2);
    assert.deepEqual(items[0], {
      type: 'TextBlock',
      text: 'Abwesenheiten',
      weight: 'Bolder',
      size: 'Medium',
      wrap: true,
    });
    const table = items[1] as Record<string, unknown>;
    assert.equal(table['type'], 'Table');
    assert.equal(table['firstRowAsHeader'], true);
    assert.deepEqual(table['columns'], [{ width: 1 }, { width: 1 }]);
    const rows = table['rows'] as Array<Record<string, unknown>>;
    assert.equal(rows.length, 3);
    // Header row: bolded labels
    const header = rows[0]!;
    assert.equal(header['type'], 'TableRow');
    const headerCells = header['cells'] as Array<Record<string, unknown>>;
    assert.equal(headerCells.length, 2);
    const headerCellItems0 = (
      headerCells[0]!['items'] as Array<Record<string, unknown>>
    )[0]!;
    assert.equal(headerCellItems0['text'], 'Mitarbeiter');
    assert.equal(headerCellItems0['weight'], 'Bolder');
    // First body row
    const body0 = rows[1]!;
    const cells0 = body0['cells'] as Array<Record<string, unknown>>;
    const cell00 = (cells0[0]!['items'] as Array<Record<string, unknown>>)[0]!;
    assert.equal(cell00['text'], 'Anna Müller');
    assert.equal(cell00['wrap'], true);
  });

  it('renders emptyText TextBlock when rows are empty', () => {
    const items = runAdaptive({
      template: {
        format: 'adaptive-card',
        sections: [
          {
            kind: 'data-table',
            sourceTool: 'query_odoo_hr',
            sourcePath: 'absences',
            title: 'Abwesenheiten',
            emptyText: 'Heute keine Einträge.',
            columns: [{ label: 'Name', field: 'name' }],
          },
        ],
      },
      raw: { query_odoo_hr: { absences: [] } },
    });
    assert.equal(items.length, 2);
    assert.equal((items[0] as Record<string, unknown>)['type'], 'TextBlock');
    assert.deepEqual(items[1], {
      type: 'TextBlock',
      text: 'Heute keine Einträge.',
      wrap: true,
    });
  });

  it('renders emptyText fallback (—) when emptyText omitted', () => {
    const items = runAdaptive({
      template: {
        format: 'adaptive-card',
        sections: [
          {
            kind: 'data-table',
            sourceTool: 'query_odoo_hr',
            sourcePath: 'absences',
            columns: [{ label: 'Name', field: 'name' }],
          },
        ],
      },
      raw: { query_odoo_hr: { absences: [] } },
    });
    assert.deepEqual(items, [{ type: 'TextBlock', text: '—', wrap: true }]);
  });

  it('formats date and currency columns via Intl', () => {
    const items = runAdaptive({
      template: {
        format: 'adaptive-card',
        sections: [
          {
            kind: 'data-table',
            sourceTool: 't',
            sourcePath: 'rows',
            columns: [
              { label: 'Bis', field: 'until', format: 'date' },
              { label: 'Preis', field: 'price', format: 'currency' },
            ],
          },
        ],
      },
      raw: { t: { rows: [{ until: '2026-05-15', price: 99.5 }] } },
      locale: 'de-DE',
      currency: 'EUR',
    });
    const table = items[0] as Record<string, unknown>;
    const rows = table['rows'] as Array<Record<string, unknown>>;
    const body = rows[1]!;
    const cells = body['cells'] as Array<Record<string, unknown>>;
    const dateCell = (
      cells[0]!['items'] as Array<Record<string, unknown>>
    )[0]!;
    const priceCell = (
      cells[1]!['items'] as Array<Record<string, unknown>>
    )[0]!;
    assert.equal(dateCell['text'], '15.05.2026');
    assert.match(priceCell['text'] as string, /99,50/);
    assert.match(priceCell['text'] as string, /€/);
  });

  it('groupBy emits one sub-header TextBlock + one Table per bucket in first-seen order', () => {
    const items = runAdaptive({
      template: {
        format: 'adaptive-card',
        sections: [
          {
            kind: 'data-table',
            sourceTool: 't',
            sourcePath: 'rows',
            groupBy: 'type',
            columns: [{ label: 'Name', field: 'name' }],
          },
        ],
      },
      raw: {
        t: {
          rows: [
            { type: 'Urlaub', name: 'A' },
            { type: 'Krank', name: 'B' },
            { type: 'Urlaub', name: 'C' },
          ],
        },
      },
    });
    // sub-header Urlaub, Table (A,C), sub-header Krank, Table (B)
    assert.equal(items.length, 4);
    assert.equal((items[0] as Record<string, unknown>)['text'], 'Urlaub');
    assert.equal((items[0] as Record<string, unknown>)['weight'], 'Bolder');
    assert.equal((items[1] as Record<string, unknown>)['type'], 'Table');
    assert.equal((items[2] as Record<string, unknown>)['text'], 'Krank');
    assert.equal((items[3] as Record<string, unknown>)['type'], 'Table');
  });
});

describe('renderRoutineTemplate — adaptive-card data-list', () => {
  it('renders bullet list as a single markdown TextBlock', () => {
    const items = runAdaptive({
      template: {
        format: 'adaptive-card',
        sections: [
          {
            kind: 'data-list',
            sourceTool: 't',
            sourcePath: 'items',
            itemTemplate: '{{ name }} ({{ count }})',
          },
        ],
      },
      raw: { t: { items: [{ name: 'A', count: 3 }, { name: 'B', count: 1 }] } },
    });
    assert.equal(items.length, 1);
    const block = items[0] as Record<string, unknown>;
    assert.equal(block['type'], 'TextBlock');
    assert.equal(block['text'], '- A (3)\n- B (1)');
    assert.equal(block['wrap'], true);
  });

  it('renders emptyText TextBlock when items are empty', () => {
    const items = runAdaptive({
      template: {
        format: 'adaptive-card',
        sections: [
          {
            kind: 'data-list',
            sourceTool: 't',
            sourcePath: 'items',
            itemTemplate: '{{ name }}',
            emptyText: 'Nichts dabei.',
          },
        ],
      },
      raw: { t: { items: [] } },
    });
    assert.deepEqual(items, [{ type: 'TextBlock', text: 'Nichts dabei.', wrap: true }]);
  });
});

describe('renderRoutineTemplate — adaptive-card composition', () => {
  it('composes sections in template order, mixed kinds, with no empty entries', () => {
    const items = runAdaptive({
      template: {
        format: 'adaptive-card',
        sections: [
          { kind: 'narrative-slot', id: 'intro' },
          {
            kind: 'data-table',
            sourceTool: 't',
            sourcePath: 'rows',
            title: 'Daten',
            columns: [{ label: 'X', field: 'x' }],
          },
          { kind: 'narrative-slot', id: 'summary' },
          { kind: 'static-markdown', text: '_footer_' },
        ],
      },
      raw: { t: { rows: [{ x: 1 }] } },
      slots: { intro: 'Hallo.', summary: 'Tschüss.' },
    });
    // intro / title / Table / summary / footer
    assert.equal(items.length, 5);
    assert.equal((items[0] as Record<string, unknown>)['text'], 'Hallo.');
    assert.equal((items[1] as Record<string, unknown>)['text'], 'Daten');
    assert.equal((items[2] as Record<string, unknown>)['type'], 'Table');
    assert.equal((items[3] as Record<string, unknown>)['text'], 'Tschüss.');
    assert.equal((items[4] as Record<string, unknown>)['text'], '_footer_');
  });

  it('returns empty array when every section collapses to empty', () => {
    const items = runAdaptive({
      template: {
        format: 'adaptive-card',
        sections: [
          { kind: 'narrative-slot', id: 'missing' },
          { kind: 'static-markdown', text: '   ' },
        ],
      },
    });
    assert.deepEqual(items, []);
  });
});
