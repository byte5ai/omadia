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
  MaterializerError,
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
