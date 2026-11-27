/**
 * #2315 (ADR-0277) — `ConfigStore.claimConfigRevision` against a real
 * Postgres: one counter per resource, a stale `expected` refused, and of two
 * concurrent writes based on the same revision exactly one passes.
 *
 * Applies the ACTUAL migration 0121 (twice) on a minimal `agents` table in its
 * own schema; skips cleanly when no test Postgres is reachable.
 */
import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';

import { probePgTest } from './_helpers/pgTestDb.js';

import {
  AgentConfigRevisionConflictError,
  ConfigStore,
} from '../packages/harness-orchestrator/src/registry/configStore.js';

const { url: PG_URL, reachable: pgAvailable } = await probePgTest({
  label: 'configStoreConfigRevisions',
  vars: ['GRAPH_PG_TEST_URL', 'MEMORY_PG_TEST_URL', 'DATABASE_URL'],
  timeoutMs: 1_500,
});

const MIGRATION = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'migrations',
  '0121_agent_config_revisions.sql',
);
const SCHEMA = `cfgrev_${String(process.pid)}`;
const AGENT = '11111111-1111-4111-8111-111111111111';

describe('ConfigStore config revisions (pg, #2315)', { skip: !pgAvailable }, () => {
  let pool: Pool;
  let store: ConfigStore;

  before(async () => {
    pool = new Pool({ connectionString: PG_URL, max: 4 });
    pool.on('connect', (client) => {
      void client.query(`SET search_path TO ${SCHEMA}`);
    });
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await pool.query(`CREATE SCHEMA ${SCHEMA}`);
    await pool.query(`CREATE TABLE ${SCHEMA}.agents (id uuid PRIMARY KEY)`);
    const sql = await readFile(MIGRATION, 'utf8');
    await pool.query(`SET search_path TO ${SCHEMA}; ${sql}`);
    await pool.query(`SET search_path TO ${SCHEMA}; ${sql}`);
    await pool.query(`INSERT INTO ${SCHEMA}.agents (id) VALUES ($1)`, [AGENT]);
    store = new ConfigStore(pool);
  });

  after(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await pool.end();
  });

  it('starts at 0 per resource, counts each resource on its own and refuses a stale expected', async () => {
    assert.equal((await store.configRevisions(AGENT)).plugins, 0);
    assert.equal(await store.claimConfigRevision(AGENT, 'plugins', 0), 1);
    assert.equal(await store.claimConfigRevision(AGENT, 'plugins'), 2);
    assert.equal(await store.claimConfigRevision(AGENT, 'fast_lane', 0), 1);
    await assert.rejects(
      store.claimConfigRevision(AGENT, 'plugins', 1),
      (err: unknown) =>
        err instanceof AgentConfigRevisionConflictError && err.currentRevision === 2 && err.expectedRevision === 1,
    );
    const all = await store.configRevisions(AGENT);
    assert.equal(all.plugins, 2);
    assert.equal(all.fast_lane, 1);
    assert.equal(all.bindings, 0);
  });

  it('lets exactly one of two concurrent writes based on the same revision pass', async () => {
    const base = (await store.configRevisions(AGENT)).availability;
    const results = await Promise.allSettled([
      store.claimConfigRevision(AGENT, 'availability', base),
      store.claimConfigRevision(AGENT, 'availability', base),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(results.filter((r) => r.status === 'rejected').length, 1);
    assert.equal((await store.configRevisions(AGENT)).availability, base + 1);
  });
});
