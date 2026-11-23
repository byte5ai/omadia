/**
 * #1876 (spec 2042 §8 item 10) — the per-agent fast lane switch
 * (`agents.fast_lane`, migration 0096): on by default, off sticks, and a
 * patch that does not mention it leaves it alone.
 */

import { strict as assert } from 'node:assert';
import { dirname, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';

import { probePgTest } from './_helpers/pgTestDb.js';

import { ConfigStore } from '../packages/harness-orchestrator/src/registry/configStore.js';
import { runMultiOrchestratorMigrations } from '../packages/harness-orchestrator/src/registry/migrator.js';

const { url: PG_URL, reachable: pgAvailable } = await probePgTest({
  label: 'agentFastLane',
  vars: ['GRAPH_PG_TEST_URL', 'MEMORY_PG_TEST_URL', 'DATABASE_URL'],
  timeoutMs: 1_500,
});

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const SCHEMA = `agent_fast_lane_${String(process.pid)}`;

describe('#1876 agents.fast_lane (pg)', { skip: !pgAvailable }, () => {
  let pool: Pool;

  before(async () => {
    const bootstrap = new Pool({ connectionString: PG_URL, max: 1 });
    await bootstrap.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await bootstrap.query(`CREATE SCHEMA ${SCHEMA}`);
    await bootstrap.end();
    pool = new Pool({ connectionString: PG_URL, max: 2, options: `-c search_path=${SCHEMA},public` });
    await runMultiOrchestratorMigrations(pool, () => undefined, MIGRATIONS_DIR);
  });

  after(async () => {
    await pool?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => undefined);
    await pool?.end();
  });

  it('defaults on, switches off, and survives an unrelated patch', async () => {
    const store = new ConfigStore(pool);
    const agent = await store.createAgent({ slug: 'erika', name: 'Erika' });
    assert.equal(agent.fastLane, true);
    await store.updateAgent(agent.id, { fastLane: false });
    assert.equal((await store.getAgentBySlug('erika'))?.fastLane, false);
    await store.updateAgent(agent.id, { name: 'Erika M.' });
    assert.equal((await store.getAgentBySlug('erika'))?.fastLane, false, 'COALESCE keeps it');
  });
});
