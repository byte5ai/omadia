/**
 * Spec 2042 §5.4 (pg, migration 0100) — the discussions configured under
 * #1018 keep working after 0097: every two agents enabled in the same chat get
 * grants in both directions, scoped to that chat's channel type, and both
 * consultation switches. Nothing else: no capability, no memory, no
 * facilitator, no deleted agent, no pair that never shared a chat. An
 * operator's existing grant is kept. Applied twice, like the CI schema job.
 */

import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';

import { probePgTest } from '../_helpers/pgTestDb.js';

import { ConfigStore } from '../../packages/harness-orchestrator/src/registry/configStore.js';
import { runMultiOrchestratorMigrations } from '../../packages/harness-orchestrator/src/registry/migrator.js';
import { ConsultationStore } from '../../src/consultation/consultationStore.js';

const { url: PG_URL, reachable: pgAvailable } = await probePgTest({
  label: 'discussion rollout',
  vars: ['GRAPH_PG_TEST_URL', 'MEMORY_PG_TEST_URL', 'DATABASE_URL'],
  timeoutMs: 1_500,
});

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');
const SCHEMA = `discussion_rollout_${String(process.pid)}`;
const CHAT = '19:sales@thread.v2';

describe('migration 0100: grants for configured discussions', { skip: !pgAvailable }, () => {
  let pool: Pool;
  let consultation: ConsultationStore;
  const ids: Record<string, string> = {};

  before(async () => {
    const bootstrap = new Pool({ connectionString: PG_URL, max: 1 });
    await bootstrap.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await bootstrap.query(`CREATE SCHEMA ${SCHEMA}`);
    await bootstrap.end();
    pool = new Pool({ connectionString: PG_URL, max: 2, options: `-c search_path=${SCHEMA},public` });
    await runMultiOrchestratorMigrations(pool, () => undefined, MIGRATIONS_DIR);
    const config = new ConfigStore(pool);
    consultation = new ConsultationStore(() => pool);
    for (const slug of ['hr', 'sales', 'acct', 'fac', 'gone', 'solo']) {
      ids[slug] = (
        await config.createAgent({ slug, name: slug, ...(slug === 'fac' ? { archetype: 'facilitator' } : {}) })
      ).id;
    }
    await pool.query(`UPDATE agents SET agent_to_agent = 'on' WHERE slug <> 'acct'`);
    // hr, sales, fac, gone and acct (switched off) are enabled in the sales chat;
    // solo is enabled only in a chat nobody else is in.
    for (const slug of ['hr', 'sales', 'acct', 'fac', 'gone']) {
      await pool.query(
        `INSERT INTO agent_channel_policies (channel_type, channel_key, agent_id, agent_to_agent) VALUES ('teams', $1, $2, true)`,
        [CHAT, ids[slug]],
      );
    }
    await pool.query(
      `INSERT INTO agent_channel_policies (channel_type, channel_key, agent_id, agent_to_agent) VALUES ('slack', 'C1', $1, true)`,
      [ids['solo']],
    );
    await pool.query(`UPDATE agents SET deleted_at = now(), deleted_by = 'op' WHERE id = $1`, [ids['gone']]);
    // An operator already granted sales → hr with a capability: kept as it is.
    await consultation.upsertGrant(ids['sales']!, ids['hr']!, { allowedCapabilities: ['@omadia/crm'] }, 'op');
    const sql = await readFile(resolve(MIGRATIONS_DIR, '0100_discussion_consultation_grants.sql'), 'utf8');
    await pool.query(sql);
    await pool.query(sql);
  });

  after(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await pool.end();
  });

  it('grants the two enabled agents both ways, scoped to the channel, and nothing else', async () => {
    const { rows } = await pool.query<{ f: string; t: string; channel_scope: string[]; created_by: string }>(
      `SELECT f.slug AS f, t.slug AS t, g.channel_scope, g.created_by
         FROM agent_consultation_grants g
         JOIN agents f ON f.id = g.from_agent_id
         JOIN agents t ON t.id = g.to_agent_id
        ORDER BY f.slug, t.slug`,
    );
    assert.deepEqual(
      rows.map((r) => [r.f, r.t, r.channel_scope, r.created_by]),
      [
        ['hr', 'sales', ['teams'], 'migration:0100'],
        ['sales', 'hr', null, 'op'],
      ],
    );
    const backfilled = await consultation.getGrant(ids['hr']!, ids['sales']!);
    assert.deepEqual(
      [backfilled?.allowedCapabilities, backfilled?.memoryAccess, backfilled?.disclosure],
      [[], 'none', {}],
    );
    const kept = await consultation.getGrant(ids['sales']!, ids['hr']!);
    assert.deepEqual(kept?.allowedCapabilities, ['@omadia/crm']);
  });

  it('switches on both agents, so the discussion in the chat keeps working', async () => {
    assert.deepEqual(await consultation.getSwitches(ids['hr']!), { consultable: true, mayConsult: true });
    assert.deepEqual(await consultation.getSwitches(ids['sales']!), { consultable: true, mayConsult: true });
    assert.deepEqual(await consultation.getSwitches(ids['solo']!), { consultable: false, mayConsult: false });
    assert.equal(await consultation.hasMutualGrants(ids['hr']!, ids['sales']!, 'teams'), true);
    assert.equal(await consultation.hasMutualGrants(ids['hr']!, ids['sales']!, 'slack'), false);
  });
});
