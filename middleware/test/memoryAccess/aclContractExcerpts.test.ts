/**
 * The memory ACL contract (`aclContract.ts`) for excerpts on the in-memory
 * graph, at today's default (`KG_RECALL_TEAM_VISIBILITY` on). The owner-only
 * setting is `aclContractExcerptsOwnerOnly.test.ts`, in its own file because
 * the in-memory excerpt search is slow. Neon: `aclContract.pg.test.ts`.
 */
import { runAclContract } from './aclContract.js';
import { seedInMemory } from './backends.js';
import { buildWorld } from './world.js';

runAclContract('InMemoryKnowledgeGraph', 'excerpt', () => seedInMemory(buildWorld()));
