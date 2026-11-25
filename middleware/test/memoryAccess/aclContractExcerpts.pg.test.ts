/**
 * The memory ACL contract (`aclContract.ts`) on Neon (pgvector): the ACL SQL
 * of `searchMemorableKnowledgeByEmbedding` and `searchExcerptsByEmbedding`
 * (owners, visibility, sharedOnly, viewerAgentSlug, audienceOwners,
 * excludeUnprotected, tenant) against the hand-written oracle.
 *
 * Excerpts here; memorable knowledge in `aclContract.pg.test.ts`.
 *
 * Needs a pgvector Postgres in GRAPH_PG_TEST_URL or MEMORY_PG_TEST_URL;
 * skips without one (issue #572). Runs in `npm run test:pg`.
 */
import { after, before } from 'node:test';

import { Pool } from 'pg';

import { probePgTest } from '../_helpers/pgTestDb.js';
import { runAclContract } from './aclContract.js';
import { seedNeon, type NeonSeeded } from './backends.js';
import type { Seeded } from './seed.js';
import { buildWorld } from './world.js';

const { url: PG_URL, reachable: pgUp } = await probePgTest({
  label: 'memoryAccess/aclContractExcerpts',
  vars: ['GRAPH_PG_TEST_URL', 'MEMORY_PG_TEST_URL'],
  requireVector: true,
});
const pool = pgUp ? new Pool({ connectionString: PG_URL, max: 4 }) : undefined;
let neon: NeonSeeded | undefined;

before(async () => {
  if (!pool) return;
  const t0 = performance.now();
  neon = await seedNeon(pool, buildWorld());
  console.error(
    `[memoryAccess/aclContractExcerpts] seeded Neon in ${((performance.now() - t0) / 1000).toFixed(1)} s`,
  );
});

const setup = async (): Promise<Seeded | undefined> => neon?.seeded;

runAclContract('NeonKnowledgeGraph (real PG)', 'excerpt', setup);
runAclContract('NeonKnowledgeGraph (real PG)', 'excerpt', setup, { teamVisibility: false });

after(async () => {
  if (!pool) return;
  await neon?.clean();
  await pool.end();
});
