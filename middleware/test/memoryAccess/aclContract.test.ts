/**
 * The memory ACL contract (`aclContract.ts`) for memorable knowledge on the
 * in-memory graph. Excerpts: `aclContractExcerpts.test.ts`. Neon:
 * `aclContract.pg.test.ts`.
 */
import { runAclContract, runEmptyAudienceContract } from './aclContract.js';
import { seedInMemory } from './backends.js';
import type { Seeded } from './seed.js';
import { buildWorld } from './world.js';

let seeded: Promise<Seeded> | undefined;
const setup = (): Promise<Seeded> => (seeded ??= seedInMemory(buildWorld()));

runAclContract('InMemoryKnowledgeGraph', 'memorable-knowledge', setup);
runAclContract('InMemoryKnowledgeGraph', 'memorable-knowledge', setup, { teamVisibility: false });
runEmptyAudienceContract('InMemoryKnowledgeGraph', setup);
