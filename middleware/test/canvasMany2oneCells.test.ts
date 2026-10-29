/**
 * Live finding (v417): an agent-filled "Offene Posten" table showed the
 * Partner column as `[51,"Europemobile GmbH"]` — the dataset column is keyed
 * by path (`partner_id`), so the cell held the raw Odoo many2one pair, and
 * the refresh path JSON-stringified it. Cells now show the display name.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { displayCell, mapRefreshRecords } from '../packages/harness-plugin-fast-path/src/refreshRecipes.js';
import { handleCanvasPublishRows } from '../packages/omadia-ui-orchestrator/src/plugin.js';

describe('displayCell', () => {
  it('many2one pair → its name', () => {
    assert.equal(displayCell([51, 'Europemobile GmbH']), 'Europemobile GmbH');
  });

  it('scalars stay, empty → blank, a scalar list is joined', () => {
    assert.equal(displayCell(72401.39), 72401.39);
    assert.equal(displayCell(true), true);
    assert.equal(displayCell('INV/1'), 'INV/1');
    assert.equal(displayCell(null), '');
    assert.equal(displayCell(undefined), '');
    assert.equal(displayCell([3, 5, 8]), '3, 5, 8');
    assert.equal(displayCell(['a', null, 'b']), 'a, b');
  });

  it('a genuinely nested value still falls back to JSON', () => {
    assert.equal(displayCell({ a: 1 }), '{"a":1}');
    assert.equal(displayCell([[1, 'x']]), '[[1,"x"]]');
  });
});

describe('refresh rows', () => {
  it('a column mapped to the many2one itself shows the name', () => {
    const raw = JSON.stringify({
      records: [{ id: 709, name: 'EBINV/2023/00010', partner_id: [51, 'Europemobile GmbH'], amount_residual: 72401.39 }],
      truncated: false,
    });
    const mapped = mapRefreshRecords(raw, {
      tool: 'odoo_query',
      input: { model: 'account.move' },
      map: { name: 'name', partner_id: 'partner_id', amount_residual: 'amount_residual' },
      itemsPath: 'records',
      rowKey: 'id',
    });
    assert.deepEqual(mapped?.rows[0], {
      name: 'EBINV/2023/00010',
      partner_id: 'Europemobile GmbH',
      amount_residual: 72401.39,
      rowKey: '709',
    });
    // the raw record keeps the pair (currency/details read it)
    assert.deepEqual(mapped?.records[0]?.['partner_id'], [51, 'Europemobile GmbH']);
  });
});

describe('canvas_publish_rows', () => {
  const payloadRows = (out: string): Array<Record<string, unknown>> =>
    (JSON.parse(out) as { _pendingStructuredPayload: { data: { rows: Array<Record<string, unknown>> } } })
      ._pendingStructuredPayload.data.rows;

  it('dataset rows: many2one cells become names, numbers stay numbers', async () => {
    const out = await handleCanvasPublishRows(
      { containerId: 'open_items', datasetId: 'ds_1' },
      () => ({
        rows: [{ id: 709, name: 'EBINV/2023/00010', partner_id: [51, 'Europemobile GmbH'], amount_residual: 72401.39 }],
        columns: [
          { path: 'name', type: 'string' },
          { path: 'partner_id', type: 'string' },
          { path: 'amount_residual', type: 'number' },
        ],
      }) as never,
    );
    const [row] = payloadRows(out);
    assert.equal(row?.['partner_id'], 'Europemobile GmbH');
    assert.equal(row?.['amount_residual'], 72401.39);
    assert.equal(row?.['id'], 709);
  });

  it('inline rows get the same treatment', async () => {
    const out = await handleCanvasPublishRows({
      containerId: 'open_items',
      rows: [{ partner: [30, 'Carrera Toys GmbH'], amount: 2500 }],
    });
    assert.deepEqual(payloadRows(out)[0], { partner: 'Carrera Toys GmbH', amount: 2500 });
  });
});
