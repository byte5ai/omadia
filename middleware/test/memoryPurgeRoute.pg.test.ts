import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';

import { Pool } from 'pg';

import { runAuthMigrations } from '../src/auth/migrator.js';
import { probePgTest } from './_helpers/pgTestDb.js';
import { ADMIN_SESSION, makeHarness, previewAndPurge } from './_helpers/memoryPurgeHarness.js';

/**
 * The memory-purge router's audit trail on real Postgres: the
 * `memory_purge_audit` row and the `admin_audit` entry a purge writes. The
 * rest of the router is covered in `memoryPurgeRoute.test.ts`. Needs a
 * Postgres in `MEMORY_PG_TEST_URL` or `GRAPH_PG_TEST_URL` (no default port,
 * issue #572); skips without one. Runs in `npm run test:pg`.
 */

const { url: PG_URL, reachable: pgUp } = await probePgTest({
  label: 'memoryPurgeRoute',
  vars: ['MEMORY_PG_TEST_URL', 'GRAPH_PG_TEST_URL'],
});

describe('memory-purge router · audit on real Postgres', () => {
  let pool: Pool | undefined;

  before(async () => {
    if (!pgUp) return;
    pool = new Pool({ connectionString: PG_URL, max: 2 });
    await pool.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
    // `admin_audit` lives in the auth series; the purge writes to it.
    await runAuthMigrations(pool);
  });

  after(async () => {
    await pool?.end();
  });

  it('PG: the audit row names the signed-in user and the counts', async (t) => {
    if (!pool) return t.skip('no test database');
    const h = await makeHarness({ graphPool: pool });
    try {
      const r = await previewAndPurge(h, { axis: 'agent', selector: 'a' });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const row = await pool.query<Record<string, unknown>>(
        `SELECT actor, actor_id, actor_email, axis, selector, status,
                scratch_deleted, kg_deleted, conversation_deleted, completed_at
           FROM memory_purge_audit WHERE id = $1`,
        [r.body['auditId']],
      );
      const audit = row.rows[0]!;
      assert.equal(audit['actor'], ADMIN_SESSION.email);
      assert.equal(audit['actor_id'], ADMIN_SESSION.uid);
      assert.equal(audit['actor_email'], ADMIN_SESSION.email);
      assert.equal(audit['axis'], 'agent');
      assert.equal(audit['selector'], 'a');
      assert.equal(audit['status'], 'completed');
      assert.equal(audit['scratch_deleted'], 2);
      assert.equal(audit['kg_deleted'], 1);
      assert.equal(audit['conversation_deleted'], 17);
      assert.ok(audit['completed_at'] instanceof Date);

      // The same purge sits in the admin trail (/admin/audit) next to the
      // other admin actions.
      const ledger = await pool.query<Record<string, unknown>>(
        `SELECT actor_id, actor_email, after FROM admin_audit
          WHERE action = 'memory.purge' AND target = $1`,
        [`memory-purge:${String(r.body['auditId'])}`],
      );
      assert.equal(ledger.rowCount, 1);
      assert.equal(ledger.rows[0]!['actor_id'], ADMIN_SESSION.uid);
      assert.equal(ledger.rows[0]!['actor_email'], ADMIN_SESSION.email);
      assert.deepEqual((ledger.rows[0]!['after'] as Record<string, unknown>)['planned'], {
        scratch: 2,
        kg: 1,
        kgDeowned: 0,
        kgExcerpts: 0,
        conversation: 17,
        datasets: 0,
        processes: 0,
        identity: 0,
        generatedFiles: 0,
        reseedEntries: [],
      });
    } finally {
      await h.close();
    }
  });
});
