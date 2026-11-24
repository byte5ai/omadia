/**
 * Memory-ACL plan step 3 — canary sweep on Neon (pgvector), context memory
 * `off`. The same real turns as the in-memory sweep, plus process memory
 * and its tools, which only Neon has (see canarySweepSuite.ts).
 *
 * Needs a pgvector Postgres in GRAPH_PG_TEST_URL or MEMORY_PG_TEST_URL;
 * skips without one. Runs in `npm run test:pg`.
 */
import { Pool } from 'pg';

import { probePgTest } from '../_helpers/pgTestDb.js';
import { seedNeon } from './backends.js';
import { canarySweepSuite } from './canarySweepSuite.js';
import { buildWorld } from './world.js';

const { url, reachable } = await probePgTest({
  label: 'memoryAccess/canarySweepOff',
  vars: ['GRAPH_PG_TEST_URL', 'MEMORY_PG_TEST_URL'],
  requireVector: true,
});

canarySweepSuite(['off'], {
  backend: 'neon',
  // Halves the turns on Neon; Boreas's items stay seeded and must stay out.
  viewerAgents: ['atlas'],
  setup: async () => {
    if (!reachable) return undefined;
    const pool = new Pool({ connectionString: url, max: 4 });
    const { seeded, clean } = await seedNeon(pool, buildWorld());
    return {
      seeded,
      teardown: async () => {
        await clean();
        await pool.end();
      },
    };
  },
});
