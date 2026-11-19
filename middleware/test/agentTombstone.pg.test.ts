/**
 * #2088 — deleting an agent keeps a tombstone (pg, migration 0072).
 *
 * The row stays, marked deleted, and nothing that references it is dropped.
 * It is hidden from every list and lookup of agents, its slug is free again,
 * a conversation bound to it stays bound (routing refuses it; it never falls
 * to the default agent), and the hard delete with the cascade is a separate
 * operation that only works on a tombstone.
 */

import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';

import { probePgTest } from './_helpers/pgTestDb.js';

import { AgentGraphStore } from '../packages/harness-orchestrator/src/registry/agentGraphStore.js';
import { ConfigStore } from '../packages/harness-orchestrator/src/registry/configStore.js';
import { runMultiOrchestratorMigrations } from '../packages/harness-orchestrator/src/registry/migrator.js';

const { url: PG_URL, reachable: pgAvailable } = await probePgTest({
  label: 'agentTombstone',
  vars: ['GRAPH_PG_TEST_URL', 'MEMORY_PG_TEST_URL', 'DATABASE_URL'],
  timeoutMs: 1_500,
});

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const SCHEMA = `agent_tombstone_${String(process.pid)}`;

describe('agent tombstones (pg, migration 0072)', { skip: !pgAvailable }, () => {
  let pool: Pool;
  let store: ConfigStore;
  let graph: AgentGraphStore;
  const count = async (table: string, column: string, id: string): Promise<number> =>
    Number((await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table} WHERE ${column} = $1`, [id])).rows[0]!.n);

  /** An agent with a row in every kind of child the delete used to cascade to. */
  async function agentWithChildren(slug: string) {
    const agent = await store.createAgent({ slug, name: slug.toUpperCase() });
    await store.upsertAgentPlugin(agent.id, { pluginId: '@omadia/integration-odoo' });
    await pool.query(`INSERT INTO channel_bindings (channel_type, channel_key, agent_id) VALUES ('teams', $1, $2)`, [
      `19:${slug}@thread.v2`,
      agent.id,
    ]);
    await pool.query(`INSERT INTO agent_identities (agent_id, display_name) VALUES ($1, $2)`, [agent.id, `${slug} display`]);
    await pool.query(
      `INSERT INTO agent_schedules (agent_id, cron) VALUES ($1, '0 9 * * 1')`,
      [agent.id],
    );
    await pool.query(
      `INSERT INTO agent_channel_policies (channel_type, channel_key, agent_id, agent_to_agent) VALUES ('teams', '19:shared@thread.v2', $1, 'on')`,
      [agent.id],
    );
    return agent;
  }

  before(async () => {
    const bootstrap = new Pool({ connectionString: PG_URL, max: 1 });
    await bootstrap.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await bootstrap.query(`CREATE SCHEMA ${SCHEMA}`);
    await bootstrap.end();
    pool = new Pool({ connectionString: PG_URL, max: 3, options: `-c search_path=${SCHEMA},public` });
    await runMultiOrchestratorMigrations(pool, () => undefined, MIGRATIONS_DIR);
    // The CI schema job applies everything twice.
    const tombstones = await readFile(resolve(MIGRATIONS_DIR, '0072_agent_tombstones.sql'), 'utf8');
    await pool.query(tombstones);
    store = new ConfigStore(pool);
    graph = new AgentGraphStore(pool);
  });

  after(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await pool.end();
  });

  it('a delete marks the row and drops none of what references it', async () => {
    const sales = await agentWithChildren('sales');
    const tombstone = await store.deleteAgent(sales.id, 'marcel@example.test');
    assert.deepEqual(
      [tombstone?.id, tombstone?.slug, tombstone?.name, tombstone?.archetype, tombstone?.deletedBy],
      [sales.id, 'sales', 'SALES', 'standard', 'marcel@example.test'],
    );
    assert.ok(Date.parse(tombstone!.deletedAt) > 0);
    // The row and every child are still there.
    assert.equal(await count('agents', 'id', sales.id), 1);
    for (const [table, column] of [
      ['agent_plugins', 'agent_id'],
      ['channel_bindings', 'agent_id'],
      ['agent_identities', 'agent_id'],
      ['agent_schedules', 'agent_id'],
      ['agent_channel_policies', 'agent_id'],
    ] as const) {
      assert.equal(await count(table, column, sales.id), 1, `${table} lost the row of a deleted agent`);
    }
    // A second delete finds no live agent.
    assert.equal(await store.deleteAgent(sales.id), undefined);
  });

  it('a tombstone is in no list and no lookup of agents', async () => {
    const tombstone = (await store.listTombstones()).find((t) => t.slug === 'sales');
    assert.ok(tombstone);
    assert.equal((await store.listAgents()).some((a) => a.id === tombstone.id), false);
    assert.equal(await store.getAgentById(tombstone.id), undefined);
    assert.equal(await store.getAgentBySlug('sales'), undefined);
    assert.equal(await store.getAgentBySlug(`deleted-${tombstone.id.replace(/-/g, '').slice(0, 20)}`), undefined);
    // Cross-agent lists leave its rows out…
    assert.equal((await store.listAllAgentPlugins()).some((p) => p.agentId === tombstone.id), false);
    assert.equal((await graph.listAllSchedules()).some((s) => s.agentId === tombstone.id), false, 'its schedule would fire');
    assert.equal(
      (await store.listChannelPeerPolicies('teams', '19:shared@thread.v2')).some((p) => p.agentId === tombstone.id),
      false,
    );
    // …and the snapshot the registry is built from has nothing of it but its binding.
    const snapshot = await store.loadSnapshot();
    assert.equal(snapshot.agents.some((a) => a.id === tombstone.id), false);
    assert.equal(snapshot.agentPlugins.some((p) => p.agentId === tombstone.id), false);
    assert.equal((snapshot.schedules ?? []).some((s) => s.agentId === tombstone.id), false);
    assert.deepEqual(
      snapshot.channelBindings.filter((b) => b.agentId === tombstone.id).map((b) => b.channelKey),
      ['19:sales@thread.v2'],
      'the conversation stays bound to the deleted agent, so routing can refuse it',
    );
    assert.deepEqual(
      (snapshot.tombstones ?? []).map((t) => [t.id, t.slug, t.name]),
      [[tombstone.id, 'sales', 'sales display']],
      'named as it was shown, for the day a notice can say who was deleted',
    );
  });

  it('the name is free: a new agent takes the slug, and is a different agent', async () => {
    const again = await store.createAgent({ slug: 'sales', name: 'Sales (new)' });
    const tombstone = (await store.listTombstones()).find((t) => t.slug === 'sales')!;
    assert.notEqual(again.id, tombstone.id);
    assert.equal((await store.getAgentBySlug('sales'))?.id, again.id);
    assert.equal((await store.listAllAgentPlugins()).some((p) => p.agentId === again.id), false, 'nothing is inherited');
  });

  it('a tombstone is final, and the default agent cannot become one', async () => {
    const tombstone = (await store.listTombstones()).find((t) => t.slug === 'sales')!;
    await assert.rejects(
      pool.query('UPDATE agents SET deleted_at = NULL WHERE id = $1', [tombstone.id]),
      (err: { constraint?: string }) => err.constraint === 'agents_tombstone_final',
    );
    const fallback = await store.createAgent({ slug: 'fallback', name: 'Standard' });
    await store.setFallbackAgentId(fallback.id);
    await assert.rejects(
      store.deleteAgent(fallback.id),
      (err: { constraint?: string }) => err.constraint === 'agents_default_not_deleted',
    );
    assert.equal((await store.getAgentBySlug('fallback'))?.id, fallback.id);
    await store.setFallbackAgentId(null);
  });

  it('the purge is the hard delete, and only a tombstone can be purged', async () => {
    const live = await agentWithChildren('hr');
    assert.equal(await store.purgeAgent(live.id), false, 'a live agent is deleted first');
    assert.equal(await count('agents', 'id', live.id), 1);

    const tombstone = (await store.listTombstones()).find((t) => t.slug === 'sales')!;
    assert.equal(await store.purgeAgent(tombstone.id), true);
    assert.equal(await count('agents', 'id', tombstone.id), 0);
    for (const table of ['agent_plugins', 'channel_bindings', 'agent_identities', 'agent_schedules', 'agent_channel_policies']) {
      assert.equal(await count(table, 'agent_id', tombstone.id), 0, `${table} kept rows of a purged agent`);
    }
    assert.equal((await store.listTombstones()).some((t) => t.id === tombstone.id), false);
    assert.equal(await store.purgeAgent(tombstone.id), false);
  });

  it('a facilitator keeps its archetype as a tombstone', async () => {
    const mara = await store.createAgent({ slug: 'mara', name: 'Mara', archetype: 'facilitator' });
    const tombstone = await store.deleteAgent(mara.id);
    assert.equal(tombstone?.archetype, 'facilitator');
    const row = await pool.query<{ kind: string; archetype: string; status: string }>(
      'SELECT kind, archetype, status FROM agents WHERE id = $1',
      [mara.id],
    );
    assert.deepEqual(row.rows[0], { kind: 'facilitator', archetype: 'facilitator', status: 'disabled' });
  });
});
