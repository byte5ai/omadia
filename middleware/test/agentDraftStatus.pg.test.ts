/**
 * #2049 — migration 0085: an agent row may be a `draft` (a preview agent),
 * and no other new status is accepted.
 */

import { strict as assert } from 'node:assert';
import { dirname, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';

import { probePgTest } from './_helpers/pgTestDb.js';

import { ConfigStore } from '../packages/harness-orchestrator/src/registry/configStore.js';
import { runMultiOrchestratorMigrations } from '../packages/harness-orchestrator/src/registry/migrator.js';
import { PreviewDraftAgents } from '../src/plugins/builder/previewDraftAgents.js';

const { url: PG_URL, reachable: pgAvailable } = await probePgTest({
  label: 'agentDraftStatus',
  vars: ['GRAPH_PG_TEST_URL', 'MEMORY_PG_TEST_URL', 'DATABASE_URL'],
  timeoutMs: 1_500,
});

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const SCHEMA = `agent_draft_status_${String(process.pid)}`;

describe('agent draft status (pg, migration 0085)', { skip: !pgAvailable }, () => {
  let pool: Pool;
  let store: ConfigStore;

  before(async () => {
    const bootstrap = new Pool({ connectionString: PG_URL, max: 1 });
    await bootstrap.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await bootstrap.query(`CREATE SCHEMA ${SCHEMA}`);
    await bootstrap.end();
    pool = new Pool({ connectionString: PG_URL, max: 2, options: `-c search_path=${SCHEMA},public` });
    await runMultiOrchestratorMigrations(pool, () => undefined, MIGRATIONS_DIR);
    store = new ConfigStore(pool);
  });

  after(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await pool.end();
  });

  it('stores a draft agent and enables it later', async () => {
    const draft = await store.createAgent({ slug: 'strategist-preview', name: 'Strategist', status: 'draft' });
    assert.equal(draft.status, 'draft');
    const { rows } = await pool.query<{ status: string }>(`SELECT status FROM agents WHERE id = $1`, [draft.id]);
    assert.equal(rows[0]?.status, 'draft');
    await pool.query(`UPDATE agents SET status = 'enabled' WHERE id = $1`, [draft.id]);
  });

  it('a Plugin Builder preview draft agent is created once and removed without a trace', async () => {
    const drafts = new PreviewDraftAgents(() => store);
    const ref = await drafts.ensure('draft-pg-1', 'Weather');
    assert.equal((await drafts.ensure('draft-pg-1', 'Weather')).id, ref.id);
    const { rows: before } = await pool.query<{ status: string }>(`SELECT status FROM agents WHERE id = $1`, [ref.id]);
    assert.equal(before[0]?.status, 'draft');
    assert.equal(await drafts.remove('draft-pg-1'), true);
    const { rows: after } = await pool.query(`SELECT 1 FROM agents WHERE id = $1`, [ref.id]);
    assert.equal(after.length, 0, 'purged, no tombstone left behind');
    // The boot sweep finds what a crash left and nothing else.
    await drafts.ensure('draft-pg-2', 'Weather');
    await store.createAgent({ slug: 'mira-draft', name: 'Mira', status: 'draft' });
    assert.equal(await drafts.sweep(), 1);
    assert.ok(await store.getAgentBySlug('mira-draft'));
  });

  it('refuses any other status', async () => {
    await assert.rejects(
      pool.query(`INSERT INTO agents (slug, name, status) VALUES ('x-bad', 'X', 'preview')`),
      /agents_status_check/,
    );
  });
});
