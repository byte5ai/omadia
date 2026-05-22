import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import {
  GRAPH_EDGE_TYPES,
  GRAPH_NODE_TYPES,
  validateNodeProps,
} from '@omadia/knowledge-graph-neon';

/**
 * Slice 1a — NorthData/OpenRegister domain purge.
 *
 * Three test surfaces:
 *   1. Migration 0014 SQL is shaped correctly — DELETEs the 3 node types
 *      and 5 edge types, verifies completeness in a DO block.
 *   2. The Neon schema enums no longer expose the removed types.
 *   3. `validateNodeProps` rejects the removed node types — anything still
 *      trying to ingest a Company/Person/FinancialSnapshot fails loudly.
 *
 * Live-DB integration (migration runs end-to-end on a seeded schema and
 * fully purges) is covered by `scripts/smoke/slice-1a-purge.ts` against
 * the dev Neon DSN, not the unit suite, to keep CI hermetic.
 */

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATION_PATH = join(
  here,
  '..',
  'packages',
  'harness-knowledge-graph-neon',
  'src',
  'migrations',
  '0014_drop_company_domain.sql',
);

const REMOVED_NODE_TYPES = ['Company', 'Person', 'FinancialSnapshot'] as const;
const REMOVED_EDGE_TYPES = [
  'MANAGES',
  'SHAREHOLDER_OF',
  'SUCCEEDED_BY',
  'HAS_FINANCIALS',
  'REFERS_TO',
] as const;

describe('Slice 1a · migration 0014 SQL file', () => {
  it('deletes the 5 NorthData edge types', async () => {
    const sql = await readFile(MIGRATION_PATH, 'utf8');
    assert.match(
      sql,
      /DELETE FROM graph_edges\s+WHERE type IN \('MANAGES', 'SHAREHOLDER_OF', 'SUCCEEDED_BY', 'HAS_FINANCIALS', 'REFERS_TO'\)/,
      'edge DELETE must cover all 5 removed edge types',
    );
  });

  it('deletes the 3 NorthData node types', async () => {
    const sql = await readFile(MIGRATION_PATH, 'utf8');
    assert.match(
      sql,
      /DELETE FROM graph_nodes\s+WHERE type IN \('Company', 'Person', 'FinancialSnapshot'\)/,
      'node DELETE must cover all 3 removed node types',
    );
  });

  it('verifies purge completeness via a DO block that RAISES on residue', async () => {
    const sql = await readFile(MIGRATION_PATH, 'utf8');
    assert.match(sql, /DO \$\$/, 'must wrap verification in DO block');
    assert.match(
      sql,
      /RAISE EXCEPTION 'Slice 1a purge incomplete/,
      'must raise when residue remains',
    );
  });

  it('runs in a single transaction', async () => {
    const sql = await readFile(MIGRATION_PATH, 'utf8');
    assert.match(sql, /^BEGIN;/m);
    assert.match(sql, /^COMMIT;/m);
  });
});

describe('Slice 1a · schema enum cleanup', () => {
  for (const removed of REMOVED_NODE_TYPES) {
    it(`GRAPH_NODE_TYPES no longer contains '${removed}'`, () => {
      assert.equal(
        (GRAPH_NODE_TYPES as readonly string[]).includes(removed),
        false,
      );
    });
  }

  for (const removed of REMOVED_EDGE_TYPES) {
    it(`GRAPH_EDGE_TYPES no longer contains '${removed}'`, () => {
      assert.equal(
        (GRAPH_EDGE_TYPES as readonly string[]).includes(removed),
        false,
      );
    });
  }
});

describe('Slice 1a · validateNodeProps rejects removed types', () => {
  for (const removed of REMOVED_NODE_TYPES) {
    it(`throws on type='${removed}'`, () => {
      assert.throws(() =>
        validateNodeProps(removed as never, {} as Record<string, unknown>),
      );
    });
  }
});
