/**
 * `ConfigStore.listChannelIdentities` against a real Postgres.
 *
 * The projection `28:` + lower(app_id) is the whole contract: it must equal,
 * byte for byte, the key the Teams plugin builds with `teamsBotKey()` and
 * receives as `activity.recipient.id`. Exact string equality is what routes,
 * so the casing rule is asserted against the real column rather than a mock —
 * an operator-pasted uppercase GUID must not split a bot off its own agent.
 *
 * Schema comes from the ACTUAL migration file (0049), applied twice, so the
 * query and the migration cannot drift apart silently. Runs in its own schema
 * (search_path pinned per connection) so parallel pg suites never collide, and
 * skips cleanly when no test Postgres is reachable.
 */

import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';

import { probePgTest } from './_helpers/pgTestDb.js';

import { ConfigStore } from '../packages/harness-orchestrator/src/registry/configStore.js';

const { url: PG_URL, reachable: pgAvailable } = await probePgTest({
  label: 'configStoreChannelIdentities',
  vars: ['GRAPH_PG_TEST_URL', 'MEMORY_PG_TEST_URL', 'DATABASE_URL'],
  timeoutMs: 1_500,
});

const MIGRATIONS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'migrations',
);

/** Only 0049 — the query touches `agent_teams_identities` and nothing else. */
const MIGRATION_FILE = '0049_agent_teams_identities.sql';

const SCHEMA = `chanident_${String(process.pid)}`;

describe('ConfigStore.listChannelIdentities (pg)', { skip: !pgAvailable }, () => {
  let pool: Pool;
  let store: ConfigStore;

  before(async () => {
    pool = new Pool({ connectionString: PG_URL, max: 2 });
    pool.on('connect', (client) => {
      void client.query(`SET search_path TO ${SCHEMA}, public`);
    });
    await pool.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
    const sql = await readFile(resolve(MIGRATIONS_DIR, MIGRATION_FILE), 'utf8');
    // Twice — the migrations README demands every file be re-appliable.
    await pool.query(sql);
    await pool.query(sql);
    store = new ConfigStore(pool);
  });

  after(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM agent_teams_identities');
  });

  async function insert(
    agentId: string,
    botSlug: string,
    appId: string | null,
  ): Promise<void> {
    await pool.query(
      `INSERT INTO agent_teams_identities
         (agent_id, bot_slug, display_name, state, app_id)
       VALUES ($1, $2, $2, 'installed', $3)`,
      [agentId, botSlug, appId],
    );
  }

  it('projects each provisioned bot to its 28:<appId> routing key', async () => {
    await insert('agent-hr', 'hr-bitch', '3D78D742-EEFB-4FB2-BAE5-3687F24C46FC');
    await insert('agent-messias', 'messias', '19ad2729-f7d3-4099-9d2a-7da1230c9533');

    const rows = await store.listChannelIdentities();

    assert.deepEqual(
      rows.map((r) => ({ ...r })),
      [
        {
          channelType: 'teams',
          channelKey: '28:19ad2729-f7d3-4099-9d2a-7da1230c9533',
          agentId: 'agent-messias',
        },
        {
          // Uppercase in the column, lowercase on the wire — the projection
          // normalizes so mixed casing can never split routing.
          channelType: 'teams',
          channelKey: '28:3d78d742-eefb-4fb2-bae5-3687f24c46fc',
          agentId: 'agent-hr',
        },
      ],
    );
  });

  it('skips runs that have not registered an app yet', async () => {
    await insert('agent-pending', 'pending-bot', null);
    await insert('agent-empty', 'empty-bot', '');

    assert.deepEqual(await store.listChannelIdentities(), []);
  });

  it('returns nothing when the platform identity table is absent', async () => {
    // An embedding host that ran the orchestrator's own migrations but not
    // the platform series. "No table" means "no provisioned bots" — it must
    // not take the snapshot load, and with it the registry boot, down.
    const bare = `${SCHEMA}_bare`;
    const barePool = new Pool({ connectionString: PG_URL, max: 1 });
    barePool.on('connect', (client) => {
      void client.query(`SET search_path TO ${bare}`);
    });
    try {
      await barePool.query(`CREATE SCHEMA IF NOT EXISTS ${bare}`);
      assert.deepEqual(await new ConfigStore(barePool).listChannelIdentities(), []);
    } finally {
      await barePool.query(`DROP SCHEMA IF EXISTS ${bare} CASCADE`);
      await barePool.end();
    }
  });
});
