import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  NeonKnowledgeGraph,
  createNeonPool,
} from '@omadia/knowledge-graph-neon';

/**
 * Live-Neon integration test for the #430 fixup — round-2 review finding 3
 * (`contains` filter's ILIKE wildcard escaping). Gated on `DATABASE_URL`,
 * same convention as `palaiaHybridRetrievalNeon.test.ts`, so a default
 * `npm test` without env stays fully hermetic; requires migration
 * `0029_datasets.sql` to already be applied on the target DB.
 *
 * Self-contained (unlike the palaia test, doesn't rely on pre-existing dev-DB
 * fixtures): ingests its own tiny dataset per test run via `ingestDataset`.
 */

const DSN = process.env['DATABASE_URL'];
const ENABLED = typeof DSN === 'string' && DSN.length > 0;

const describeIf = ENABLED ? describe : describe.skip;

describeIf('NeonKnowledgeGraph — dataset contains-filter wildcard escaping (#430 fixup)', () => {
  it('matches a literal % / _ in the filter value as a literal substring, not a SQL wildcard', async () => {
    const pool = createNeonPool(DSN as string);
    const graph = new NeonKnowledgeGraph({ pool, tenantId: `test-${String(Date.now())}` });
    try {
      const { datasetId } = await graph.ingestDataset({
        ownerOmadiaUserId: 'user-1',
        name: 'Discounts',
        sourceFileName: 'discounts.csv',
        columns: [{ name: 'label', type: 'string' }],
        rows: [
          { label: '10% off' },
          { label: '10x off' }, // would ALSO match unescaped `%` as a wildcard
          { label: 'no_discount' },
          { label: 'noXdiscount' }, // would ALSO match unescaped `_` as a wildcard
        ],
      });

      const percent = await graph.queryDatasetRows(datasetId, 'user-1', {
        filters: [{ column: 'label', op: 'contains', value: '10%' }],
      });
      assert.equal(percent?.totalMatched, 1, 'literal "10%" must match only "10% off", not "10x off"');

      const underscore = await graph.queryDatasetRows(datasetId, 'user-1', {
        filters: [{ column: 'label', op: 'contains', value: 'no_discount' }],
      });
      assert.equal(
        underscore?.totalMatched,
        1,
        'literal "no_discount" must match only itself, not "noXdiscount"',
      );
    } finally {
      await pool.end();
    }
  });
});
