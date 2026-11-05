import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';

import type { WorkflowGraph } from '@omadia/conductor-core';
import { Pool } from 'pg';

import { probePgTest } from './_helpers/pgTestDb.js';

import { runConductorMigrations } from '../src/conductor/migrator.js';
import { ConductorWorkflowStore } from '../src/conductor/workflowStore.js';

// `activeVersionNumber` is a correlated subselect shared by every read and by the
// publish's RETURNING. A scripted pool cannot prove either: this runs the real SQL,
// in particular that RETURNING sees the version inserted earlier in its transaction.

const { url: PG_URL, reachable: pgAvailable } = await probePgTest({
  label: 'conductorWorkflowStore',
  vars: ['GRAPH_PG_TEST_URL', 'MEMORY_PG_TEST_URL', 'DATABASE_URL'],
  timeoutMs: 1_500,
});

const GRAPH: WorkflowGraph = {
  entryStepId: 's',
  steps: [{ id: 's', kind: 'agent', agentId: 'a', prompt: 'p' }],
  transitions: [],
};

/** Same retry as conductorWebhookEndpointStore.pg.test.ts: two test files can race
 *  the migrator on a fresh database, and the loser rolls back with a 23505. */
async function migrateWithRetry(pool: Pool): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await runConductorMigrations(pool);
      return;
    } catch (err) {
      if ((err as { code?: string } | undefined)?.code !== '23505' || attempt >= 5) throw err;
    }
  }
}

describe('ConductorWorkflowStore.activeVersionNumber (real Postgres)', { skip: !pgAvailable }, () => {
  let pool: Pool;
  let store: ConductorWorkflowStore;
  const slug = `version-number-${randomUUID()}`;

  before(async () => {
    pool = new Pool({ connectionString: PG_URL, max: 2 });
    await migrateWithRetry(pool);
    store = new ConductorWorkflowStore(pool);
  });

  after(async () => {
    await pool.query('DELETE FROM conductor_workflows WHERE slug = $1', [slug]);
    await pool.end();
  });

  it('follows every publish on the publish result, list() and getBySlug()', async () => {
    const first = await store.createOrPublish({ slug, name: 'Numbered', graph: GRAPH });
    assert.equal(first.workflow.activeVersionNumber, 1);

    const second = await store.createOrPublish({ slug, name: 'Numbered', graph: GRAPH });
    assert.equal(second.version.version, 2);
    assert.equal(second.workflow.activeVersionNumber, 2);

    assert.equal((await store.getBySlug(slug))?.activeVersionNumber, 2);
    const listed = (await store.list()).find((wf) => wf.slug === slug);
    assert.equal(listed?.activeVersionNumber, 2);
  });
});
