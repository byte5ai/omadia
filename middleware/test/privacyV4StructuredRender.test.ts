import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { createDatasetStore } from '@omadia/plugin-privacy-guard/dist/v4/datasetStore.js';
import { buildDigest } from '@omadia/plugin-privacy-guard/dist/v4/digest.js';
import { materialize } from '@omadia/plugin-privacy-guard/dist/v4/materializer.js';
import { createShapeClassifier } from '@omadia/plugin-privacy-guard/dist/v4/shapeClassifier.js';

const HR_LEAVE = [
  { employee: 'Marvin Vomberg', days: 24 },
  { employee: 'Anna Rüsche', days: 30 },
  { employee: 'Thomas Görres', days: 18 },
];

function harness() {
  const classify = createShapeClassifier();
  return createDatasetStore({ classify, buildDigest, turnId: 'turn-structured-render' });
}

describe('Privacy Shield v4 structured table render', () => {
  it('marks masked columns, keeps safe columns plain, and exposes real cell values', () => {
    const store = harness();
    const { datasetId } = store.internToolResult('hr.leave', HR_LEAVE);
    const dataset = store.get(datasetId);
    assert.ok(dataset, 'interned dataset is available in the turn store');

    const employeeField = dataset.schema.fields.find((field) => field.path === 'employee');
    const daysField = dataset.schema.fields.find((field) => field.path === 'days');
    assert.ok(employeeField, 'employee field exists');
    assert.ok(daysField, 'days field exists');
    assert.equal(employeeField.classification, 'sensitive-masked');
    assert.equal(daysField.classification, 'safe-cleartext');

    const result = materialize(store, {
      datasetId,
      columns: [
        { field: 'employee', label: 'Employee' },
        { field: 'days', label: 'Days' },
      ],
      format: 'table',
    });

    assert.ok(result.structuredTable, 'table render exposes a structured table');

    const maskedColumn = result.structuredTable.columns.find(
      (column) => column.fieldKey === 'employee',
    );
    const safeColumn = result.structuredTable.columns.find(
      (column) => column.fieldKey === 'days',
    );
    assert.ok(maskedColumn, 'employee column is present');
    assert.ok(safeColumn, 'days column is present');
    assert.equal(maskedColumn.privacy, 'guard-protected');
    assert.equal(safeColumn.privacy, undefined);

    assert.deepEqual(
      result.structuredTable.rows.map((row) => row.rowKey),
      ['r0', 'r1', 'r2'],
    );
    assert.equal(result.structuredTable.rows[0]?.cells.employee, 'Marvin Vomberg');
    assert.equal(result.structuredTable.rows[0]?.cells.days, '24');
    assert.ok(
      result.structuredTable.rows.every((row) => row.cells.employee !== '[masked]'),
      'structured cells keep the real resolved identity values',
    );
  });

  it('does not expose a structured table for list renders', () => {
    const store = harness();
    const { datasetId } = store.internToolResult('hr.leave', HR_LEAVE);

    const result = materialize(store, {
      datasetId,
      columns: [
        { field: 'employee', label: 'Employee' },
        { field: 'days', label: 'Days' },
      ],
      format: 'list',
    });

    assert.equal(result.structuredTable, undefined);
  });
});
