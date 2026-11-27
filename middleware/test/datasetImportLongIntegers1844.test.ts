/**
 * #1844 part 5 — digit runs longer than a double holds stay exact: their
 * column is typed `string` (and so passes the privacy scan) instead of
 * `number`, which rounded `9007199254740993` to `…992`.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { buildDatasetFromCsv } from '../packages/harness-orchestrator/src/datasetImport.js';

describe('#1844 — long integers', () => {
  it('keeps 16+ digit identifiers exact as strings', async () => {
    const built = await buildDatasetFromCsv(
      Buffer.from('OrderNo,Qty\n9007199254740993,1\n1234567890123456789,2\n', 'utf8'),
    );
    assert.ok(built.ok);
    assert.equal(built.columns.find((c) => c.name === 'OrderNo')?.type, 'string');
    assert.equal(built.columns.find((c) => c.name === 'Qty')?.type, 'number');
    assert.equal(built.rows[0]?.['OrderNo'], '9007199254740993');
    assert.equal(built.rows[1]?.['OrderNo'], '1234567890123456789');
  });

  it('still types a 15-digit integer and an ordinary decimal as number', async () => {
    const built = await buildDatasetFromCsv(
      Buffer.from('n\n123456789012345\n12.5\n', 'utf8'),
    );
    assert.ok(built.ok);
    assert.equal(built.columns[0]?.type, 'number');
    assert.equal(built.rows[0]?.['n'], 123456789012345);
  });
});
