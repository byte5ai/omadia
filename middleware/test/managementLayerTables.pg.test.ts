/**
 * #2055 — the management layer's tables (pg, migrations 0081–0083).
 *
 *  - the former fallback agent becomes the instance entry of the default-agent
 *    table; a database without one starts `off`;
 *  - one entry per (principal, channel) scope; the instance entry cannot be
 *    removed, only set `off`;
 *  - agents that existed before 0083 stay available to everyone, a fresh
 *    agent is available to nobody;
 *  - a deleted agent that an entry or a selection still names is not purged.
 */

import { strict as assert } from 'node:assert';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';

import { probePgTest } from './_helpers/pgTestDb.js';

import { ConfigStore, ConfigValidationError } from '../packages/harness-orchestrator/src/registry/configStore.js';

const { url: PG_URL, reachable: pgAvailable } = await probePgTest({
  label: 'managementLayerTables',
  vars: ['GRAPH_PG_TEST_URL', 'MEMORY_PG_TEST_URL', 'DATABASE_URL'],
  timeoutMs: 1_500,
});

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const SCHEMA = `mgmt_layer_${String(process.pid)}`;

async function applyMigrations(pool: Pool, filter: (file: string) => boolean): Promise<void> {
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
  for (const file of files.filter(filter)) {
    await pool.query(await readFile(resolve(MIGRATIONS_DIR, file), 'utf8'));
  }
}

describe('management layer tables (pg, migrations 0081–0083)', { skip: !pgAvailable }, () => {
  let pool: Pool;
  let store: ConfigStore;
  let fallbackId: string;
  let olderId: string;

  before(async () => {
    const bootstrap = new Pool({ connectionString: PG_URL, max: 1 });
    await bootstrap.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await bootstrap.query(`CREATE SCHEMA ${SCHEMA}`);
    await bootstrap.end();
    pool = new Pool({ connectionString: PG_URL, max: 3, options: `-c search_path=${SCHEMA},public` });
    // A live instance before S1: agents and a fallback agent.
    await applyMigrations(pool, (f) => f < '0081');
    fallbackId = (
      await pool.query<{ id: string }>(
        `INSERT INTO agents (slug, name, status) VALUES ('fallback', 'Standard', 'enabled') RETURNING id`,
      )
    ).rows[0]!.id;
    olderId = (
      await pool.query<{ id: string }>(`INSERT INTO agents (slug, name, status) VALUES ('older', 'Older', 'enabled') RETURNING id`)
    ).rows[0]!.id;
    await pool.query('UPDATE multi_orchestrator_settings SET fallback_agent_id = $1 WHERE id', [fallbackId]);
    await applyMigrations(pool, (f) => f >= '0081');
    store = new ConfigStore(pool);
  });

  after(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await pool.end();
  });

  it('the former fallback agent is the instance entry, and the settings table is gone', async () => {
    const entries = await store.routing.listDefaultEntries();
    const instance = entries.find((e) => e.principal === null && e.channelType === null);
    assert.equal(instance?.agentId, fallbackId);
    const { rows } = await pool.query(`SELECT to_regclass('multi_orchestrator_settings') AS t`);
    assert.equal(rows[0].t, null);
  });

  it('agents that existed before 0083 stay available to everyone; a fresh one to nobody', async () => {
    const older = await store.getAgentBySlug('older');
    assert.equal(older?.availableToEveryone, true);
    const fresh = await store.createAgent({ slug: 'fresh', name: 'Fresh' });
    assert.equal((await store.getAgentBySlug('fresh'))?.availableToEveryone, false);
    await store.routing.setAvailability(fresh.id, {
      everyone: false,
      channels: ['teams'],
      principals: ['user:anna@example.com', 'role:sales'],
    });
    const after = await store.getAgentBySlug('fresh');
    assert.deepEqual(after?.availableChannels, ['teams']);
    const principals = (await store.routing.listAvailabilityPrincipals()).filter((p) => p.agentId === fresh.id);
    assert.deepEqual(principals.map((p) => p.principal).sort(), ['role:sales', 'user:anna@example.com']);
  });

  it('one entry per scope; the instance entry is never removed, only set off', async () => {
    const first = await store.routing.upsertDefaultEntry({ principal: 'user:anna@example.com', channelType: 'teams', agentId: olderId });
    const again = await store.routing.upsertDefaultEntry({ principal: 'user:anna@example.com', channelType: 'teams', agentId: null });
    assert.equal(first.id, again.id);
    assert.equal(again.agentId, null);
    const instance = (await store.routing.listDefaultEntries()).find((e) => e.principal === null && e.channelType === null)!;
    assert.equal(await store.routing.deleteDefaultEntry(instance.id), false);
    assert.equal(await store.routing.deleteDefaultEntry(first.id), true);
    await assert.rejects(
      pool.query(`INSERT INTO agent_default_entries (principal, channel_type, agent_id) VALUES ('anna', NULL, NULL)`),
      /agent_default_entries_principal_form/,
    );
  });

  it('a selection per user and conversation, replaced on a new choice', async () => {
    await store.routing.setSelection({ channelType: 'telegram', conversationKey: 'g', principal: 'user:anna@example.com', agentId: olderId });
    await store.routing.setSelection({ channelType: 'telegram', conversationKey: 'g', principal: 'user:anna@example.com', agentId: fallbackId });
    const mine = (await store.routing.listSelections()).filter((s) => s.principal === 'user:anna@example.com');
    assert.equal(mine.length, 1);
    assert.equal(mine[0]?.agentId, fallbackId);
  });

  it('a deleted agent named by an entry or a selection is not purged, and a default agent can be deleted', async () => {
    await store.deleteAgent(fallbackId);
    await assert.rejects(store.purgeAgent(fallbackId), ConfigValidationError);
    await store.routing.clearSelection('telegram', 'g', 'user:anna@example.com');
    await store.routing.upsertDefaultEntry({ principal: null, channelType: null, agentId: null });
    assert.equal(await store.purgeAgent(fallbackId), true);
  });
});
