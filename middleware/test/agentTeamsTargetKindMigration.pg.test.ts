/**
 * Migration 0054 (`target_kind`) against a real Postgres — with rows that
 * already exist.
 *
 * WHY THIS SUITE IS ABOUT EXISTING DATA. `agent_teams_identities` and
 * `agent_teams_installs` hold PRODUCTION rows. Every one of them was written
 * by a code path that could only install into a team, so `DEFAULT 'team'` is
 * not an assumption about old data — it is the only thing old data could have
 * meant. That claim is worth proving rather than asserting, because getting it
 * wrong would silently relabel real installs.
 *
 * Also the double-apply proof the migrations README demands: every file in
 * this series must be re-applicable, and schema CI applies each one twice.
 *
 * Runs in its own schema (search_path pinned per connection) so parallel pg
 * suites never collide, and skips cleanly when no test Postgres is reachable.
 */

import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';

import { probePgTest } from './_helpers/pgTestDb.js';
import { AgentTeamsInstallStore } from '../src/platform/agentTeamsInstallStore.js';

const { url: PG_URL, reachable: pgAvailable } = await probePgTest({
  label: 'agentTeamsTargetKind',
  vars: ['GRAPH_PG_TEST_URL', 'MEMORY_PG_TEST_URL', 'DATABASE_URL'],
  timeoutMs: 1_500,
});

const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const SCHEMA = `teams_target_kind_${String(process.pid)}`;

async function sql(name: string): Promise<string> {
  return readFile(resolve(MIGRATIONS, name), 'utf8');
}

describe('migration 0054 — target_kind', { skip: !pgAvailable }, () => {
  let pool: Pool;

  before(async () => {
    const bootstrap = new Pool({ connectionString: PG_URL, max: 1 });
    await bootstrap.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await bootstrap.query(`CREATE SCHEMA ${SCHEMA}`);
    await bootstrap.end();
    pool = new Pool({
      connectionString: PG_URL,
      max: 2,
      options: `-c search_path=${SCHEMA}`,
    });

    // The world BEFORE 0054: schema at 0049 + 0051, with rows in it.
    await pool.query(await sql('0049_agent_teams_identities.sql'));
    await pool.query(await sql('0051_agent_teams_installs.sql'));

    await pool.query(
      `INSERT INTO agent_teams_identities (agent_id, bot_slug, display_name, state, team_id, teams_app_id)
       VALUES ('legacy-agent', 'legacy-bot', 'Legacy Bot', 'installed', 'aaaaaaaa-0000-4000-8000-000000000001', 'catalog-1')`,
    );
    await pool.query(
      `INSERT INTO agent_teams_installs (agent_id, team_id, teams_app_id, team_display_name)
       VALUES ('legacy-agent', 'aaaaaaaa-0000-4000-8000-000000000001', 'catalog-1', 'Marketing')`,
    );

    // Applied TWICE on purpose — the migrations README requires every file to
    // be re-applicable, and the schema CI gate double-applies.
    const migration = await sql('0054_agent_teams_target_kind.sql');
    await pool.query(migration);
    await pool.query(migration);
  });

  after(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await pool.end();
  });

  it('labels every PRE-EXISTING identity row as a team', async () => {
    const res = await pool.query<{ target_kind: string }>(
      `SELECT target_kind FROM agent_teams_identities WHERE agent_id = 'legacy-agent'`,
    );
    assert.equal(res.rows[0]?.target_kind, 'team');
  });

  it('labels every PRE-EXISTING binding as a team, keeping its other columns', async () => {
    const res = await pool.query<{
      target_kind: string;
      team_display_name: string | null;
      teams_app_id: string | null;
    }>(
      `SELECT target_kind, team_display_name, teams_app_id
         FROM agent_teams_installs WHERE agent_id = 'legacy-agent'`,
    );
    const row = res.rows[0];
    assert.equal(row?.target_kind, 'team');
    // The backfill must not disturb what was already there.
    assert.equal(row?.team_display_name, 'Marketing');
    assert.equal(row?.teams_app_id, 'catalog-1');
  });

  it('accepts the three installable kinds and REFUSES anything else', async () => {
    for (const kind of ['team', 'group-chat', 'one-on-one-chat']) {
      await pool.query(
        `INSERT INTO agent_teams_installs (agent_id, team_id, target_kind)
         VALUES ('legacy-agent', $1, $2)`,
        [`target-${kind}`, kind],
      );
    }
    // A channel is not an install target, so the vocabulary must not contain
    // it — the CHECK constraint is the last line of that defence.
    await assert.rejects(
      pool.query(
        `INSERT INTO agent_teams_installs (agent_id, team_id, target_kind)
         VALUES ('legacy-agent', 'target-channel', 'channel')`,
      ),
      /agent_teams_installs_target_kind_check/,
    );
  });

  it('round-trips the kind through the store the runner actually writes with', async () => {
    const store = new AgentTeamsInstallStore(pool);
    const written = await store.record({
      agentId: 'legacy-agent',
      teamId: '19:abc123@thread.v2',
      targetKind: 'group-chat',
      teamsAppId: 'catalog-2',
    });
    assert.equal(written.targetKind, 'group-chat');

    const read = await store.get('legacy-agent', '19:abc123@thread.v2');
    assert.equal(read?.targetKind, 'group-chat');
  });

  it('defaults to team when the store is called without a kind', async () => {
    // The pre-0054 call shape, which every existing caller still uses.
    const store = new AgentTeamsInstallStore(pool);
    const written = await store.record({
      agentId: 'legacy-agent',
      teamId: 'bbbbbbbb-0000-4000-8000-000000000002',
    });
    assert.equal(written.targetKind, 'team');
  });

  it('re-targets a binding kind on re-record rather than keeping a stale one', async () => {
    // An id can only be one kind, but a row rewritten after a correction must
    // not keep claiming the endpoint that never worked.
    const store = new AgentTeamsInstallStore(pool);
    await store.record({
      agentId: 'legacy-agent',
      teamId: 'cccccccc-0000-4000-8000-000000000003',
      targetKind: 'team',
    });
    const updated = await store.record({
      agentId: 'legacy-agent',
      teamId: 'cccccccc-0000-4000-8000-000000000003',
      targetKind: 'group-chat',
    });
    assert.equal(updated.targetKind, 'group-chat');
  });
});
