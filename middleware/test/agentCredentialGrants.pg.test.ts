/**
 * #2319 — migration 0125 and the Postgres stores of the credential broker
 * capability against a real database: per-agent credential grants (idempotent
 * put, cascade on agent/credential delete) and the ask delivery row that is
 * taken exactly once.
 *
 * The referenced tables are reduced to their keys: the migration only
 * depends on `agents.id`, `credentials.id` and `credential_asks.id`.
 * Skips cleanly when no test database is configured (#572).
 */
import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';

import { probePgTest } from './_helpers/pgTestDb.js';

import {
  PostgresAgentCredentialGrantStore,
  PostgresCredentialAskDeliveryStore,
} from '../src/credentials/agentCredentialGrants.js';

const { url: PG_URL, reachable: pgAvailable } = await probePgTest({
  label: 'agentCredentialGrants',
  vars: ['GRAPH_PG_TEST_URL', 'MEMORY_PG_TEST_URL', 'DATABASE_URL'],
  timeoutMs: 1_500,
});

const SCHEMA = 'test_agent_credential_grants';
const MIGRATION = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'migrations', '0125_agent_credential_grants.sql');

const STUBS = `
CREATE TABLE agents (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), slug TEXT NOT NULL);
CREATE TABLE credentials (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), name TEXT NOT NULL, revoked_at TIMESTAMPTZ);
CREATE TABLE credential_asks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  status TEXT NOT NULL DEFAULT 'pending',
  ask_expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '1 day'
);
`;

describe('agent credential grants (pg, migration 0125)', { skip: !pgAvailable }, () => {
  let pool: Pool;
  let grants: PostgresAgentCredentialGrantStore;
  let deliveries: PostgresCredentialAskDeliveryStore;

  const insertId = async (sql: string): Promise<string> => (await pool.query<{ id: string }>(sql)).rows[0]!.id;

  before(async () => {
    const bootstrap = new Pool({ connectionString: PG_URL, max: 1 });
    await bootstrap.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await bootstrap.query(`CREATE SCHEMA ${SCHEMA}`);
    await bootstrap.end();
    pool = new Pool({ connectionString: PG_URL, max: 2, options: `-c search_path=${SCHEMA},public` });
    await pool.query(STUBS);
    const migration = await readFile(MIGRATION, 'utf8');
    // Idempotent: the CI schema job applies everything twice.
    await pool.query(migration);
    await pool.query(migration);
    grants = new PostgresAgentCredentialGrantStore(pool);
    deliveries = new PostgresCredentialAskDeliveryStore(pool);
  });

  after(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE agents, credentials, credential_asks CASCADE');
  });

  it('puts a grant once, lists it, and removes it', async () => {
    const agent = await insertId(`INSERT INTO agents (slug) VALUES ('clara') RETURNING id`);
    const cred = await insertId(`INSERT INTO credentials (name) VALUES ('github') RETURNING id`);
    const first = await grants.put(agent, cred, 'op@example.com');
    const second = await grants.put(agent, cred, 'someone-else');
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(second.grant.grantedBy, 'op@example.com');
    assert.deepEqual((await grants.list(agent)).map((g) => g.credentialId), [cred]);
    assert.equal((await grants.listAll()).length, 1);
    assert.equal(await grants.remove(agent, cred), true);
    assert.equal(await grants.remove(agent, cred), false);
  });

  it('leaves grants of revoked credentials out of the offer list', async () => {
    const agent = await insertId(`INSERT INTO agents (slug) VALUES ('clara') RETURNING id`);
    const live = await insertId(`INSERT INTO credentials (name) VALUES ('live') RETURNING id`);
    const revoked = await insertId(`INSERT INTO credentials (name, revoked_at) VALUES ('old', now()) RETURNING id`);
    await grants.put(agent, live, 'op');
    await grants.put(agent, revoked, 'op');
    assert.deepEqual((await grants.listAll()).map((g) => g.credentialId), [live]);
    assert.equal((await grants.list(agent)).length, 2);
  });

  it('sweeps deliveries of asks that can no longer be decided', async () => {
    const agent = await insertId(`INSERT INTO agents (slug) VALUES ('clara') RETURNING id`);
    const open = await insertId('INSERT INTO credential_asks DEFAULT VALUES RETURNING id');
    const denied = await insertId(`INSERT INTO credential_asks (status) VALUES ('denied') RETURNING id`);
    const expired = await insertId(`INSERT INTO credential_asks (ask_expires_at) VALUES (now() - interval '1 minute') RETURNING id`);
    for (const askId of [open, denied, expired]) {
      await deliveries.put({ askId, agentId: agent, channel: 'web', conversationRef: {} });
    }
    assert.equal(await deliveries.purgeStale(new Date()), 2);
    assert.ok(await deliveries.take(open));
  });

  it('drops grants with their agent or credential', async () => {
    const agent = await insertId(`INSERT INTO agents (slug) VALUES ('clara') RETURNING id`);
    const cred = await insertId(`INSERT INTO credentials (name) VALUES ('github') RETURNING id`);
    await grants.put(agent, cred, 'op');
    await pool.query('DELETE FROM credentials WHERE id = $1', [cred]);
    assert.deepEqual(await grants.list(agent), []);
  });

  it('refuses a malformed id with 22P02, which the route reads as unknown', async () => {
    await assert.rejects(() => grants.remove('not-a-uuid', 'also-not'), (err: unknown) => (err as { code?: string }).code === '22P02');
  });

  it('hands an ask delivery out exactly once', async () => {
    const agent = await insertId(`INSERT INTO agents (slug) VALUES ('clara') RETURNING id`);
    const ask = await insertId('INSERT INTO credential_asks DEFAULT VALUES RETURNING id');
    await deliveries.put({ askId: ask, agentId: agent, channel: 'telegram', conversationRef: { chatId: '42' } });
    const [a, b] = await Promise.all([deliveries.take(ask), deliveries.take(ask)]);
    const taken = [a, b].filter((d) => d !== undefined);
    assert.equal(taken.length, 1);
    assert.deepEqual(taken[0], { askId: ask, agentId: agent, channel: 'telegram', conversationRef: { chatId: '42' } });
  });
});
