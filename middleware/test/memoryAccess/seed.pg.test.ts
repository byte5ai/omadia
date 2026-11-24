/**
 * The memory-access world seeded into the Neon backend (pgvector): every
 * canary reads back from its store, including process memory, which only
 * Neon has. This is the positive control the Postgres leg of the ACL contract
 * suite (step 2) stands on. The `/memories` tree uses the in-memory store
 * here; the Postgres memory store has its own conformance suite.
 *
 * Needs a pgvector Postgres in GRAPH_PG_TEST_URL or MEMORY_PG_TEST_URL;
 * skips without one (issue #572). Runs in `npm run test:pg`.
 */
import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';

import { Pool } from 'pg';

import { probePgTest } from '../_helpers/pgTestDb.js';
import { seedNeon, type NeonSeeded } from './backends.js';
import { readBack } from './seed.js';
import { buildWorld } from './world.js';

const { url: PG_URL, reachable: pgUp } = await probePgTest({
  label: 'memoryAccess/seed',
  vars: ['GRAPH_PG_TEST_URL', 'MEMORY_PG_TEST_URL'],
  requireVector: true,
});

describe('memory-access seed · NeonKnowledgeGraph (real PG)', () => {
  const world = buildWorld();
  let pool: Pool | undefined;
  let neon: NeonSeeded;

  before(async () => {
    if (!pgUp) return;
    pool = new Pool({ connectionString: PG_URL, max: 4 });
    neon = await seedNeon(pool, world);
  });

  after(async () => {
    if (!pool) return;
    await neon?.clean();
    await pool.end();
  });

  it('every canary reads back from its store (positive control)', async (t) => {
    if (!pool) return t.skip('no test database');
    assert.deepEqual(neon.seeded.skipped, [], 'Neon takes every store');
    const missing: string[] = [];
    for (const item of world.items) {
      const text = await readBack(neon.seeded, item);
      if (!text?.includes(item.canary)) missing.push(`${item.store} ${item.canary}`);
    }
    assert.deepEqual(missing, []);
  });
});
