/**
 * Spec 2042 §6 criteria 36 and 39, "also after a restart" (pg): the routing
 * state lives in the database, so a NEW ConfigStore on the same database —
 * what a restarted instance builds — routes exactly as before.
 *
 *  - 36: a group bound to A; U selected B, V selected C: U → B, V → C,
 *    everyone else → A.
 *  - 39: A is deleted (tombstone), the instance restarts: the binding and
 *    the stored selection still name A (`agent_deleted`), the user's default
 *    agent B gets no turn; after the target is changed, routing follows it.
 */

import { strict as assert } from 'node:assert';
import { dirname, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';

import { probePgTest } from './_helpers/pgTestDb.js';

import { ConfigStore } from '../packages/harness-orchestrator/src/registry/configStore.js';
import { runMultiOrchestratorMigrations } from '../packages/harness-orchestrator/src/registry/migrator.js';
import { SnapshotRoutingView } from '../packages/harness-orchestrator/src/registry/routingView.js';
import {
  ManagementRouter,
  type RouteOutcome,
  type RouteRequest,
} from '../packages/harness-orchestrator/src/routing/managementRouter.js';

const { url: PG_URL, reachable: pgAvailable } = await probePgTest({
  label: 'routingAfterRestart',
  vars: ['GRAPH_PG_TEST_URL', 'MEMORY_PG_TEST_URL', 'DATABASE_URL'],
  timeoutMs: 1_500,
});

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const SCHEMA = `routing_restart_${String(process.pid)}`;

const U = 'user:ursula@example.com';
const V = 'user:viktor@example.com';
const W = 'user:wanda@example.com';
const GROUP = { channelType: 'telegram', channelKey: '-100group' };

describe('routing after a restart (pg)', { skip: !pgAvailable }, () => {
  let pool: Pool;
  const ids: Record<'a' | 'b' | 'c', string> = { a: '', b: '', c: '' };

  /** What a restarted instance does: a fresh store, a fresh snapshot, a fresh router. */
  async function restartedRoute(request: RouteRequest): Promise<RouteOutcome> {
    const snapshot = await new ConfigStore(pool).loadSnapshot();
    return new ManagementRouter({ view: new SnapshotRoutingView(snapshot) }).route(request);
  }

  const slugOf = (o: RouteOutcome): string | undefined => (o.kind === 'agent' ? o.slug : undefined);

  before(async () => {
    const bootstrap = new Pool({ connectionString: PG_URL, max: 1 });
    await bootstrap.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await bootstrap.query(`CREATE SCHEMA ${SCHEMA}`);
    await bootstrap.end();
    pool = new Pool({ connectionString: PG_URL, max: 3, options: `-c search_path=${SCHEMA},public` });
    await runMultiOrchestratorMigrations(pool, () => undefined, MIGRATIONS_DIR);

    // The instance before the restart: written through its own store.
    const before = new ConfigStore(pool);
    for (const slug of ['a', 'b', 'c'] as const) {
      const row = await before.createAgent({ slug, name: slug.toUpperCase() });
      await before.routing.setAvailability(row.id, { everyone: true, channels: null, principals: [] });
      ids[slug] = row.id;
    }
    await before.createChannelBinding(ids.a, GROUP);
    await before.routing.setSelection({ channelType: GROUP.channelType, conversationKey: GROUP.channelKey, principal: U, agentId: ids.b });
    await before.routing.setSelection({ channelType: GROUP.channelType, conversationKey: GROUP.channelKey, principal: V, agentId: ids.c });
    // U's own default agent is B (criterion 39: B never takes A's place).
    await before.routing.upsertDefaultEntry({ principal: U, channelType: null, agentId: ids.b });
    // A stored selection of A in U's Slack DM (criterion 39, "the same for the selection").
    await before.routing.setSelection({ channelType: 'slack', conversationKey: 'D-ursula', principal: U, agentId: ids.a });
  });

  after(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await pool.end();
  });

  it("criterion 36: after a restart U's unaddressed messages reach B, V's reach C, everyone else's reach A", async () => {
    assert.equal(slugOf(await restartedRoute({ ...GROUP, principal: U })), 'b');
    assert.equal(slugOf(await restartedRoute({ ...GROUP, principal: V })), 'c');
    assert.equal(slugOf(await restartedRoute({ ...GROUP, principal: W })), 'a');
    assert.equal(slugOf(await restartedRoute(GROUP)), 'a', 'a sender without principal reaches the binding too');
  });

  it('criterion 39: A deleted, instance restarted — binding and selection name A, B gets no turn', async () => {
    const tombstone = await new ConfigStore(pool).deleteAgent(ids.a, 'operator@example.com');
    assert.equal(tombstone?.id, ids.a);

    for (const [label, request] of [
      ['binding (V has a selection of C, so ask as W)', { ...GROUP, principal: W }],
      ['selection in the Slack DM', { channelType: 'slack', channelKey: 'D-ursula', principal: U }],
    ] as const) {
      const outcome = await restartedRoute(request);
      assert.equal(outcome.kind, 'notice', `${label}: ${JSON.stringify(outcome)}`);
      assert.equal(outcome.kind === 'notice' && outcome.code, 'agent_deleted', label);
      assert.equal(outcome.kind === 'notice' && outcome.agent?.agentId, ids.a, label);
      assert.equal(outcome.kind === 'notice' && outcome.agent?.displayName, 'A', label);
    }
    // U's own selection of B in the group is untouched by A's deletion.
    assert.equal(slugOf(await restartedRoute({ ...GROUP, principal: U })), 'b');
  });

  it('criterion 39: after the target is changed, routing follows it (also after a restart)', async () => {
    const store = new ConfigStore(pool);
    await store.removeChannelBinding(GROUP.channelType, GROUP.channelKey);
    await store.createChannelBinding(ids.c, GROUP);
    await store.routing.setSelection({ channelType: 'slack', conversationKey: 'D-ursula', principal: U, agentId: ids.c });

    assert.equal(slugOf(await restartedRoute({ ...GROUP, principal: W })), 'c');
    assert.equal(slugOf(await restartedRoute({ channelType: 'slack', channelKey: 'D-ursula', principal: U })), 'c');

    // Clearing the selection: U's default agent B answers there now.
    await store.routing.clearSelection('slack', 'D-ursula', U);
    assert.equal(slugOf(await restartedRoute({ channelType: 'slack', channelKey: 'D-ursula', principal: U })), 'b');
  });
});
