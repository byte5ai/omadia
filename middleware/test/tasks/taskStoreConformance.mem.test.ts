import { InMemoryTaskStore } from '@omadia/orchestrator';

import { runTaskStoreConformance } from './taskStoreConformance.js';

/**
 * Issue #560 — the shared conformance suite against the in-memory reference.
 * The durable twin runs the SAME suite against Postgres
 * (`durableTaskStore.pg.test.ts`); any divergence fails one side.
 */
runTaskStoreConformance('in-memory', async () => new InMemoryTaskStore());
