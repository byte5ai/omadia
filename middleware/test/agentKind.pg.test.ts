/**
 * #2060 — `agents.kind` against a real Postgres (migration 0067).
 *
 * Three facts the database itself must hold, whatever a route checks:
 * the vocabulary is closed, the kind never changes after insert, and the
 * default agent is never a facilitator. Schema comes from the actual
 * migration files, applied twice.
 */

import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';

import { probePgTest } from './_helpers/pgTestDb.js';

import {
  ConfigStore,
  ConfigValidationError,
} from '../packages/harness-orchestrator/src/registry/configStore.js';

const { url: PG_URL, reachable: pgAvailable } = await probePgTest({
  label: 'agentKind',
  vars: ['GRAPH_PG_TEST_URL', 'MEMORY_PG_TEST_URL', 'DATABASE_URL'],
  timeoutMs: 1_500,
});

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const SCHEMA = `agent_kind_${String(process.pid)}`;

describe('agents.kind (pg, migration 0067)', { skip: !pgAvailable }, () => {
  let pool: Pool;
  let store: ConfigStore;

  before(async () => {
    const bootstrap = new Pool({ connectionString: PG_URL, max: 1 });
    await bootstrap.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await bootstrap.query(`CREATE SCHEMA ${SCHEMA}`);
    await bootstrap.end();
    pool = new Pool({
      connectionString: PG_URL,
      max: 2,
      options: `-c search_path=${SCHEMA},public`,
    });
    for (const file of [
      '0001_multi_orchestrator.sql',
      '0002_fix_notify_trigger.sql',
      '0067_agent_kind.sql',
    ]) {
      const sql = await readFile(resolve(MIGRATIONS_DIR, file), 'utf8');
      await pool.query(sql);
      await pool.query(sql);
    }
    store = new ConfigStore(pool);
  });

  after(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('UPDATE multi_orchestrator_settings SET fallback_agent_id = NULL');
    await pool.query('DELETE FROM agents');
  });

  it('defaults to standard and stores facilitator on create', async () => {
    const plain = await store.createAgent({ slug: 'hr', name: 'HR' });
    const moderator = await store.createAgent({
      slug: 'mara',
      name: 'Mara',
      kind: 'facilitator',
    });
    assert.equal(plain.kind, 'standard');
    assert.equal(moderator.kind, 'facilitator');
    const reread = await pool.query<{ slug: string; kind: string }>(
      'SELECT slug, kind FROM agents ORDER BY slug',
    );
    assert.deepEqual(
      reread.rows.map((r) => [r.slug, r.kind]),
      [
        ['hr', 'standard'],
        ['mara', 'facilitator'],
      ],
    );
  });

  it('refuses a kind outside the vocabulary', async () => {
    await assert.rejects(
      pool.query(`INSERT INTO agents (slug, name, kind) VALUES ('x', 'X', 'moderator')`),
      (err: { constraint?: string }) => err.constraint === 'agents_kind_check',
    );
  });

  it('refuses to change the kind after insert, in both directions', async () => {
    const hr = await store.createAgent({ slug: 'hr', name: 'HR' });
    await store.createAgent({ slug: 'mara', name: 'Mara', kind: 'facilitator' });
    for (const [slug, target] of [
      ['hr', 'facilitator'],
      ['mara', 'standard'],
    ] as const) {
      await assert.rejects(
        pool.query('UPDATE agents SET kind = $2 WHERE slug = $1', [slug, target]),
        (err: { constraint?: string }) => err.constraint === 'agents_kind_immutable',
      );
    }
    // An update that does not touch the kind still works.
    const renamed = await pool.query<{ name: string; kind: string }>(
      `UPDATE agents SET name = 'People' WHERE id = $1 RETURNING name, kind`,
      [hr.id],
    );
    assert.deepEqual(renamed.rows[0], { name: 'People', kind: 'standard' });
  });

  it('refuses a facilitator as the default agent, at the database', async () => {
    const plain = await store.createAgent({ slug: 'hr', name: 'HR' });
    const moderator = await store.createAgent({
      slug: 'mara',
      name: 'Mara',
      kind: 'facilitator',
    });
    await assert.rejects(
      pool.query('UPDATE multi_orchestrator_settings SET fallback_agent_id = $1', [moderator.id]),
      (err: { constraint?: string }) => err.constraint === 'fallback_agent_not_facilitator',
    );
    await assert.rejects(store.setFallbackAgentId(moderator.id), ConfigValidationError);
    const settings = await store.setFallbackAgentId(plain.id);
    assert.equal(settings.fallbackAgentId, plain.id);
    assert.equal((await store.setFallbackAgentId(null)).fallbackAgentId, null);
  });
});
