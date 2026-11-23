/**
 * Migration 0105 `agent_channel_identities`, its store and the routing read
 * (`ConfigStore.listChannelIdentities`) against a real Postgres.
 *
 * Pinned: Teams rows cannot land here (they live in 0049); a key is stored
 * lowercase and belongs to one agent; one bot per agent and channel; the
 * store maps both unique violations to a typed conflict; routing reads the
 * union of both tables; a write notifies `agents_changed`; the final purge of
 * an agent takes its bots with it. Applied twice (the README demands
 * re-appliable files). Own schema, skips without a test Postgres.
 */

import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { Client, Pool } from 'pg';

import { probePgTest } from './_helpers/pgTestDb.js';

import { ConfigStore } from '../packages/harness-orchestrator/src/registry/configStore.js';
import {
  AgentChannelIdentityConflict,
  createAgentChannelIdentityStore,
} from '../src/platform/agentChannelIdentityStore.js';

const { url: PG_URL, reachable: pgAvailable } = await probePgTest({
  label: 'agentChannelIdentities',
  vars: ['GRAPH_PG_TEST_URL', 'MEMORY_PG_TEST_URL', 'DATABASE_URL'],
  timeoutMs: 1_500,
});

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const SCHEMA = `agentchanident_${String(process.pid)}`;

const MIRA = '00000000-0000-4000-8000-000000000001';
const OTTO = '00000000-0000-4000-8000-000000000002';

describe('agent_channel_identities (pg)', { skip: !pgAvailable }, () => {
  let pool: Pool;

  before(async () => {
    pool = new Pool({ connectionString: PG_URL, max: 2 });
    pool.on('connect', (client) => {
      void client.query(`SET search_path TO ${SCHEMA}`);
    });
    const admin = new Client({ connectionString: PG_URL });
    await admin.connect();
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    await admin.end();
    // Only what 0105 depends on: `agents(id)` and the notify function (0002).
    await pool.query('CREATE TABLE agents (id UUID PRIMARY KEY)');
    await pool.query(await readFile(resolve(MIGRATIONS_DIR, '0002_fix_notify_trigger.sql'), 'utf8'));
    await pool.query(await readFile(resolve(MIGRATIONS_DIR, '0049_agent_teams_identities.sql'), 'utf8'));
    const sql = await readFile(resolve(MIGRATIONS_DIR, '0105_agent_channel_identities.sql'), 'utf8');
    await pool.query(sql);
    await pool.query(sql);
  });

  after(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM agent_channel_identities');
    await pool.query('DELETE FROM agent_teams_identities');
    await pool.query('DELETE FROM agents');
    await pool.query('INSERT INTO agents (id) VALUES ($1), ($2)', [MIRA, OTTO]);
  });

  const insertRaw = (agentId: string, type: string, key: string) =>
    pool.query('INSERT INTO agent_channel_identities (agent_id, channel_type, channel_key) VALUES ($1, $2, $3)', [
      agentId,
      type,
      key,
    ]);

  it('refuses Teams, an uppercase key and an empty key', async () => {
    await assert.rejects(insertRaw(MIRA, 'teams', '28:abc'), /agent_channel_identities_type_check/);
    await assert.rejects(insertRaw(MIRA, 'telegram', 'TG:1'), /agent_channel_identities_key_check/);
    await assert.rejects(insertRaw(MIRA, 'telegram', ''), /agent_channel_identities_key_check/);
  });

  it('maps both unique rules to a typed conflict', async () => {
    const store = createAgentChannelIdentityStore(pool);
    await store.insert({ agentId: MIRA, channelType: 'telegram', channelKey: 'tg:1', externalRef: '@mira_bot' });
    await assert.rejects(
      store.insert({ agentId: OTTO, channelType: 'telegram', channelKey: 'tg:1' }),
      (err: unknown) => err instanceof AgentChannelIdentityConflict && err.reason === 'bot_taken',
    );
    await assert.rejects(
      store.insert({ agentId: MIRA, channelType: 'telegram', channelKey: 'tg:2' }),
      (err: unknown) => err instanceof AgentChannelIdentityConflict && err.reason === 'agent_has_identity',
    );
    // The same bot key on another channel type is another bot.
    await store.insert({ agentId: OTTO, channelType: 'discord', channelKey: 'tg:1' });
    assert.equal(await store.ownerOf('telegram', 'tg:1'), MIRA);
    assert.equal((await store.get(MIRA, 'telegram'))?.externalRef, '@mira_bot');
    assert.equal(await store.delete(MIRA, 'telegram'), true);
    assert.equal(await store.delete(MIRA, 'telegram'), false);
  });

  it('routing reads Teams and every other channel as one list', async () => {
    await pool.query(
      `INSERT INTO agent_teams_identities (agent_id, bot_slug, display_name, state, app_id)
       VALUES ($1, 'mira', 'Mira', 'installed', 'ABCDEF')`,
      [MIRA],
    );
    await insertRaw(MIRA, 'telegram', 'tg:7000000001');
    await insertRaw(OTTO, 'slack', 'slack-bot:u0123');
    const rows = await new ConfigStore(pool).listChannelIdentities();
    assert.deepEqual(
      rows.map((r) => [r.channelType, r.channelKey, r.agentId]),
      [
        ['teams', '28:abcdef', MIRA],
        ['slack', 'slack-bot:u0123', OTTO],
        ['telegram', 'tg:7000000001', MIRA],
      ],
    );
  });

  it('a write notifies agents_changed with the agent id', async () => {
    const listener = new Client({ connectionString: PG_URL });
    await listener.connect();
    try {
      const payloads: string[] = [];
      listener.on('notification', (n) => {
        if (n.channel === 'agents_changed' && n.payload) payloads.push(n.payload);
      });
      await listener.query('LISTEN agents_changed');
      await insertRaw(MIRA, 'telegram', 'tg:9');
      const deadline = Date.now() + 2000;
      while (!payloads.includes(MIRA) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
      }
      assert.ok(payloads.includes(MIRA));
    } finally {
      await listener.end();
    }
  });

  it("purging an agent removes its bots", async () => {
    await insertRaw(MIRA, 'telegram', 'tg:1');
    await pool.query('DELETE FROM agents WHERE id = $1', [MIRA]);
    const { rows } = await pool.query('SELECT 1 FROM agent_channel_identities');
    assert.equal(rows.length, 0);
  });
});
