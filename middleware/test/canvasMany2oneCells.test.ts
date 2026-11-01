/**
 * Live finding (v417): an agent-filled "Offene Posten" table showed the
 * Partner column as `[51,"Europemobile GmbH"]` — the dataset column is keyed
 * by path (`partner_id`), so the cell held the raw Odoo many2one pair, and
 * the refresh path JSON-stringified it. Cells now show the display name.
 * (`canvas_publish_rows` is tested in the @omadia/ui-orchestrator plugin
 * repo.)
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { displayCell, mapRefreshRecords } from '../packages/harness-plugin-fast-path/src/refreshRecipes.js';

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

