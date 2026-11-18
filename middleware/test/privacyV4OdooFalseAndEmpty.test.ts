import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { createDatasetStore } from '@omadia/plugin-privacy-guard/dist/v4/datasetStore.js';
import {
  buildDigest,
  digestToToolResultText,
} from '@omadia/plugin-privacy-guard/dist/v4/digest.js';
import { materialize } from '@omadia/plugin-privacy-guard/dist/v4/materializer.js';
import { createShapeClassifier } from '@omadia/plugin-privacy-guard/dist/v4/shapeClassifier.js';

function harness() {
  return createDatasetStore({
    classify: createShapeClassifier(),
    buildDigest,
    turnId: 'turn-odoo-false-empty',
  });
}

// #1503 — Odoo answers `false` for an EMPTY non-boolean field. The "Trainee"
// job of the Odoo demo data has no department.
const OPEN_JOBS = JSON.stringify([
  { job: 'Trainee', department_id: false },
  { job: 'Developer', department_id: [3, 'Research & Development'] },
  { job: 'Consultant', department_id: [5, 'Sales'] },
]);

describe('#1503 — Odoo `false` for an empty field', () => {
  it('renders an empty many2one as "—" in table, structured cells and list, never as "false"', () => {
    const store = harness();
    const { datasetId } = store.internToolResult('query_odoo_hr', OPEN_JOBS);
    const columns = [
      { field: 'job', label: 'Job' },
      { field: 'department_id', label: 'Department' },
    ];

    const table = materialize(store, { datasetId, columns, format: 'table' });
    assert.match(table.text, /\| Trainee \| — \|/);
    assert.doesNotMatch(table.text, /false/);
    assert.equal(table.structuredTable?.rows[0]?.cells.department_id, '—');
    assert.equal(
      table.structuredTable?.rows[1]?.cells.department_id,
      'Research & Development',
    );

    const list = materialize(store, { datasetId, columns, format: 'list' });
    assert.match(list.text, /Job: Trainee, Department: —/);
    assert.doesNotMatch(list.text, /false/);
  });

  it('never reports "false" as a protected value for the chat to highlight', () => {
    const store = harness();
    const { datasetId } = store.internToolResult('query_odoo_hr', OPEN_JOBS);
    const result = materialize(store, {
      datasetId,
      columns: [{ field: 'department_id', label: 'Department' }],
      format: 'table',
    });
    assert.ok(!result.maskedValues.includes('false'), String(result.maskedValues));
  });

  it('keeps a sparse personal-data column masked when most cells are `false`', () => {
    // Regression guard: treating Odoo's `false` as "no value" in the
    // CLASSIFIER let three e-mails among 27 `false`s pass the low-cardinality
    // enum rule into cleartext. The empty marker is a display concern only.
    const rows = Array.from({ length: 30 }, (_, i) => ({
      id: i + 1,
      email: i < 3 ? ['pa@firma.de', 'mb@firma.de', 'ck@firma.de'][i] : false,
    }));
    const store = harness();
    const { datasetId } = store.internToolResult('query_odoo_hr', JSON.stringify(rows));
    const field = store.get(datasetId)?.schema.fields.find((f) => f.path === 'email');
    assert.equal(field?.classification, 'sensitive-masked');
  });

  it('renders an empty date as "—" to the user', () => {
    const store = harness();
    const { datasetId } = store.internToolResult(
      'query_odoo_hr',
      JSON.stringify([
        { name: 'A', date_end: '2026-01-31' },
        { name: 'B', date_end: false },
      ]),
    );
    const result = materialize(store, {
      datasetId,
      columns: [
        { field: 'name', label: 'Name' },
        { field: 'date_end', label: 'End' },
      ],
      format: 'list',
    });
    assert.match(result.text, /Name: B, End: —/);
    assert.ok(!result.maskedValues.includes('false'));
  });

  it('keeps `false` in a genuine boolean column', () => {
    const store = harness();
    const { datasetId } = store.internToolResult(
      'query_odoo_hr',
      JSON.stringify([
        { job: 'Trainee', active: false },
        { job: 'Developer', active: true },
      ]),
    );
    const result = materialize(store, {
      datasetId,
      columns: [
        { field: 'job', label: 'Job' },
        { field: 'active', label: 'Active' },
      ],
      format: 'table',
    });
    assert.match(result.text, /\| Trainee \| false \|/);
    assert.equal(result.structuredTable?.rows[0]?.cells.active, 'false');
  });
});

describe('#1467 — an empty wrapper result is zero rows, not one masked row', () => {
  it('interns `{"datasets":[]}` as an empty dataset', () => {
    const store = harness();
    const { digest } = store.internToolResult(
      'query_dataset',
      JSON.stringify({ datasets: [] }),
    );
    assert.equal(digest.rowCount, 0);
    assert.equal(
      digest.fields.filter((f) => f.classification === 'sensitive-masked').length,
      0,
    );
  });

  it('interns a paged empty result `{"items":[],"total":0}` as an empty dataset', () => {
    const store = harness();
    const { digest } = store.internToolResult(
      'list_things',
      JSON.stringify({ items: [], total: 0, next: null }),
    );
    assert.equal(digest.rowCount, 0);
  });

  it('tells the model to say there is no data instead of rendering', () => {
    const store = harness();
    const { digest } = store.internToolResult(
      'query_dataset',
      JSON.stringify({ datasets: [] }),
    );
    const text = digestToToolResultText(digest);
    assert.match(text, /rowCount is 0/);
    assert.match(text, /Do not call v4_render_answer/);
  });

  it('keeps a non-empty wrapper and an object with one empty list field as they were', () => {
    const store = harness();
    const full = store.internToolResult(
      'query_dataset',
      JSON.stringify({ datasets: [{ id: 'd1', rowCount: 3 }] }),
    );
    assert.equal(full.digest.rowCount, 1);
    // A record that merely HAS an empty list is still one record, and so is
    // one whose only other field is a non-zero count.
    const record = store.internToolResult(
      'query_odoo_hr',
      JSON.stringify({ name: 'Marvin', tag_ids: [] }),
    );
    assert.equal(record.digest.rowCount, 1);
    const counted = store.internToolResult(
      'list_things',
      JSON.stringify({ items: [], total: 7 }),
    );
    assert.equal(counted.digest.rowCount, 1);
    // A non-empty digest carries no "no records" instruction.
    assert.doesNotMatch(digestToToolResultText(full.digest), /rowCount is 0/);
  });
});
