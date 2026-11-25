/**
 * The memory ACL contract (`aclContract.ts`) for excerpts on the in-memory
 * graph with team recall off (owner-only). Default setting:
 * `aclContractExcerpts.test.ts`.
 */
import { runAclContract } from './aclContract.js';
import { seedInMemory } from './backends.js';
import { buildWorld } from './world.js';

runAclContract('InMemoryKnowledgeGraph', 'excerpt', () => seedInMemory(buildWorld()), {
  teamVisibility: false,
});
