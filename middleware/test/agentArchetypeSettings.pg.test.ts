/**
 * #2066 (spec 2043 §7) — per-agent archetype settings (`agents.archetype_settings`,
 * migration 0107): empty by default, merged per key, `null` removes a key, the
 * column only holds an object, and a deleted agent has none.
 */

import { strict as assert } from 'node:assert';
import { dirname, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';

import { probePgTest } from './_helpers/pgTestDb.js';

import { ConfigStore } from '../packages/harness-orchestrator/src/registry/configStore.js';
import { runMultiOrchestratorMigrations } from '../packages/harness-orchestrator/src/registry/migrator.js';
import { createAgentArchetypeSettingsStore } from '../src/platform/agentArchetypeSettingsStore.js';

const { url: PG_URL, reachable: pgAvailable } = await probePgTest({
  label: 'agentArchetypeSettings',
  vars: ['GRAPH_PG_TEST_URL', 'MEMORY_PG_TEST_URL', 'DATABASE_URL'],
  timeoutMs: 1_500,
});

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const SCHEMA = `agent_archetype_settings_${String(process.pid)}`;

describe('#2066 agents.archetype_settings (pg)', { skip: !pgAvailable }, () => {
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

  it('starts empty, merges per key and removes a cleared key', async () => {
    const store = createAgentArchetypeSettingsStore(pool);
    const agent = await new ConfigStore(pool).createAgent({ slug: 'mara', name: 'Mara' });
    assert.deepEqual(await store.get(agent.id), {});
    assert.deepEqual(
      await store.merge(agent.id, { default_decision_method: 'consent', reminder_offsets_hours: [48, 4] }),
      { default_decision_method: 'consent', reminder_offsets_hours: [48, 4] },
    );
    assert.deepEqual(await store.merge(agent.id, { reminder_offsets_hours: null, ranked_points: [5, 3, 1] }), {
      default_decision_method: 'consent',
      ranked_points: [5, 3, 1],
    });
    assert.deepEqual(await store.get(agent.id), { default_decision_method: 'consent', ranked_points: [5, 3, 1] });
    assert.equal(await store.merge('00000000-0000-4000-8000-000000000000', { x: 'y' }), undefined);
  });

  it('holds only an object', async () => {
    const agent = await new ConfigStore(pool).createAgent({ slug: 'nina', name: 'Nina' });
    await assert.rejects(
      pool.query(`UPDATE agents SET archetype_settings = '[]'::jsonb WHERE id = $1`, [agent.id]),
      /agents_archetype_settings_object_check/,
    );
  });

  // #2066 field scenario without Teams, on the real tables (S7, migration
  // 0105): a facilitator with only its own Telegram bot is routed on
  // Telegram, which is what readiness per channel and its profile read.
  it('a facilitator with only a Telegram bot has an own identity on telegram, not on teams', async () => {
    const config = new ConfigStore(pool);
    const agent = await config.createAgent({ slug: 'tilda', name: 'Tilda', archetype: 'facilitator' });
    await pool.query(
      `INSERT INTO agent_channel_identities (agent_id, channel_type, channel_key) VALUES ($1, 'telegram', 'tg:4242')`,
      [agent.id],
    );
    const own = (await config.listChannelIdentities()).filter((i) => i.agentId === agent.id);
    assert.deepEqual(own.map((i) => [i.channelType, i.channelKey]), [['telegram', 'tg:4242']]);
  });

  it('a deleted agent has no settings and takes none', async () => {
    const store = createAgentArchetypeSettingsStore(pool);
    const agent = await new ConfigStore(pool).createAgent({ slug: 'otto', name: 'Otto' });
    await store.merge(agent.id, { default_decision_method: 'ranked' });
    await pool.query(`UPDATE agents SET deleted_at = now() WHERE id = $1`, [agent.id]);
    assert.deepEqual(await store.get(agent.id), {});
    assert.equal(await store.merge(agent.id, { default_decision_method: 'consent' }), undefined);
  });
});
