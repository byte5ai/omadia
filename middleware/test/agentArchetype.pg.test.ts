/**
 * #2088 — `agents.archetype` and the archetype registry against a real
 * Postgres (migration 0070), the EXPAND step next to `agents.kind` (0067).
 *
 * What the database itself must hold while both columns exist:
 *  - rows that existed before are backfilled, a second application changes
 *    nothing and does not trip the immutability trigger;
 *  - a writer that names only `kind` (the previous release) and one that
 *    names only `archetype` (this release) both end with the two equal;
 *  - the archetype never changes; an unregistered archetype is refused;
 *  - the default agent is never a facilitator, read from the archetype.
 */

import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';

import { probePgTest } from './_helpers/pgTestDb.js';

import { ConfigStore, ConfigValidationError } from '../packages/harness-orchestrator/src/registry/configStore.js';
import { archetypeOf, archetypeOmits } from '../packages/harness-orchestrator/src/registry/archetype.js';

const { url: PG_URL, reachable: pgAvailable } = await probePgTest({
  label: 'agentArchetype',
  vars: ['GRAPH_PG_TEST_URL', 'MEMORY_PG_TEST_URL', 'DATABASE_URL'],
  timeoutMs: 1_500,
});

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const SCHEMA = `agent_archetype_${String(process.pid)}`;
const BEFORE = ['0001_multi_orchestrator.sql', '0002_fix_notify_trigger.sql', '0067_agent_kind.sql'];
const MIGRATION = '0070_agent_archetypes.sql';

describe('agents.archetype (pg, migration 0070)', { skip: !pgAvailable }, () => {
  let pool: Pool;
  let store: ConfigStore;
  const sql = (file: string): Promise<string> => readFile(resolve(MIGRATIONS_DIR, file), 'utf8');
  const rows = async (): Promise<[string, string, string][]> =>
    (
      await pool.query<{ slug: string; kind: string; archetype: string }>(
        'SELECT slug, kind, archetype FROM agents ORDER BY slug',
      )
    ).rows.map((r) => [r.slug, r.kind, r.archetype]);

  before(async () => {
    const bootstrap = new Pool({ connectionString: PG_URL, max: 1 });
    await bootstrap.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await bootstrap.query(`CREATE SCHEMA ${SCHEMA}`);
    await bootstrap.end();
    pool = new Pool({ connectionString: PG_URL, max: 2, options: `-c search_path=${SCHEMA},public` });
    for (const file of BEFORE) await pool.query(await sql(file));
    // The live instance before this migration: standard agents and facilitators.
    await pool.query(
      `INSERT INTO agents (slug, name, kind) VALUES
         ('legacy-hr', 'HR', 'standard'),
         ('legacy-mona', 'Mona', 'facilitator'),
         ('legacy-theo', 'Theo', 'facilitator')`,
    );
    await pool.query(await sql(MIGRATION));
    store = new ConfigStore(pool);
  });

  after(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('UPDATE multi_orchestrator_settings SET fallback_agent_id = NULL');
    await pool.query(`DELETE FROM agents WHERE slug NOT LIKE 'legacy-%'`);
  });

  it('backfills existing rows from kind and seeds the registry', async () => {
    assert.deepEqual(await rows(), [
      ['legacy-hr', 'standard', 'standard'],
      ['legacy-mona', 'facilitator', 'facilitator'],
      ['legacy-theo', 'facilitator', 'facilitator'],
    ]);
    const registry = await pool.query<{ id: string; source: string }>(
      'SELECT id, source FROM agent_archetypes ORDER BY id',
    );
    assert.deepEqual(registry.rows, [
      { id: 'facilitator', source: 'kernel' },
      { id: 'standard', source: 'kernel' },
    ]);
  });

  it('a second application changes nothing and does not trip the immutability trigger', async () => {
    const before = await rows();
    await pool.query(await sql(MIGRATION));
    await pool.query(await sql(MIGRATION));
    assert.deepEqual(await rows(), before);
    const triggers = await pool.query<{ tgname: string }>(
      `SELECT tgname FROM pg_trigger
        WHERE tgrelid = 'agents'::regclass AND NOT tgisinternal AND tgname LIKE 'agents_%arche%'
        ORDER BY tgname`,
    );
    assert.deepEqual(
      triggers.rows.map((r) => r.tgname),
      ['agents_archetype_immutable', 'agents_kind_archetype_sync'],
    );
  });

  it('a writer of the previous release names only kind: the archetype follows', async () => {
    await pool.query(`INSERT INTO agents (slug, name, kind) VALUES ('old-mara', 'Mara', 'facilitator'), ('old-hr', 'HR', 'standard')`);
    assert.deepEqual((await rows()).filter(([slug]) => slug.startsWith('old-')), [
      ['old-hr', 'standard', 'standard'],
      ['old-mara', 'facilitator', 'facilitator'],
    ]);
  });

  it('this release names only the archetype: kind follows, so a machine on the previous release still sees a facilitator', async () => {
    const mara = await store.createAgent({ slug: 'mara', name: 'Mara', archetype: 'facilitator' });
    const hr = await store.createAgent({ slug: 'hr', name: 'HR' });
    const viaLegacyName = await store.createAgent({ slug: 'nora', name: 'Nora', kind: 'facilitator' });
    assert.deepEqual([mara.archetype, mara.kind], ['facilitator', 'facilitator']);
    assert.deepEqual([hr.archetype, hr.kind], ['standard', 'standard']);
    assert.equal(viaLegacyName.archetype, 'facilitator');
    assert.deepEqual((await rows()).filter(([slug]) => !slug.startsWith('legacy-')), [
      ['hr', 'standard', 'standard'],
      ['mara', 'facilitator', 'facilitator'],
      ['nora', 'facilitator', 'facilitator'],
    ]);
    // What the code decides on.
    assert.equal(archetypeOf(mara), 'facilitator');
    assert.equal(archetypeOmits(mara, 'memory'), true);
    // A row read by a machine that only knows `kind` decides the same way.
    assert.equal(archetypeOmits({ kind: 'facilitator' }, 'memory'), true);
    assert.equal(archetypeOmits(hr, 'memory'), false);
  });

  it('refuses an unregistered archetype and two names that disagree', async () => {
    await assert.rejects(
      pool.query(`INSERT INTO agents (slug, name, archetype) VALUES ('x', 'X', 'coach')`),
      // Either the FK (no such archetype) or, once the sync copied it, the closed kind vocabulary.
      (err: { constraint?: string }) =>
        err.constraint === 'agents_archetype_fkey' || err.constraint === 'agents_kind_check',
    );
    await assert.rejects(store.createAgent({ slug: 'y', name: 'Y', archetype: 'coach' }));
    assert.deepEqual((await rows()).filter(([slug]) => !slug.startsWith('legacy-')), []);
  });

  it('refuses to change the archetype after insert, in both directions; other updates work', async () => {
    const hr = await store.createAgent({ slug: 'hr', name: 'HR' });
    await store.createAgent({ slug: 'mara', name: 'Mara', archetype: 'facilitator' });
    for (const [slug, target] of [
      ['hr', 'facilitator'],
      ['mara', 'standard'],
      ['legacy-mona', 'standard'],
    ] as const) {
      await assert.rejects(
        pool.query('UPDATE agents SET archetype = $2 WHERE slug = $1', [slug, target]),
        (err: { constraint?: string }) => err.constraint === 'agents_archetype_immutable',
      );
    }
    const renamed = await pool.query<{ name: string; archetype: string }>(
      `UPDATE agents SET name = 'People' WHERE id = $1 RETURNING name, archetype`,
      [hr.id],
    );
    assert.deepEqual(renamed.rows[0], { name: 'People', archetype: 'standard' });
  });

  it('refuses a facilitator as the default agent, read from the archetype', async () => {
    const plain = await store.createAgent({ slug: 'hr', name: 'HR' });
    const moderator = await store.createAgent({ slug: 'mara', name: 'Mara', archetype: 'facilitator' });
    await assert.rejects(
      pool.query('UPDATE multi_orchestrator_settings SET fallback_agent_id = $1', [moderator.id]),
      (err: { constraint?: string }) => err.constraint === 'fallback_agent_not_facilitator',
    );
    await assert.rejects(store.setFallbackAgentId(moderator.id), ConfigValidationError);
    assert.equal((await store.setFallbackAgentId(plain.id)).fallbackAgentId, plain.id);
  });

  it('0071: a third archetype can exist once it is registered; kind follows it; unregistered stays refused', async () => {
    const open = await sql('0071_agent_archetypes_open.sql');
    await pool.query(open);
    await pool.query(open);
    // Still refused while nobody registered it: the registry is the vocabulary.
    await assert.rejects(
      pool.query(`INSERT INTO agents (slug, name, archetype) VALUES ('c1', 'C1', 'coach')`),
      (err: { constraint?: string }) => err.constraint === 'agents_archetype_fkey',
    );
    await pool.query(`INSERT INTO agent_archetypes (id, source) VALUES ('coach', '@acme/archetype-coach')`);
    const coach = await store.createAgent({ slug: 'c1', name: 'C1', archetype: 'coach' });
    assert.equal(coach.archetype, 'coach');
    assert.deepEqual((await rows()).filter(([slug]) => slug === 'c1'), [['c1', 'coach', 'coach']]);
    // The two known archetypes read exactly as before.
    const mara = await store.createAgent({ slug: 'mara', name: 'Mara', archetype: 'facilitator' });
    assert.deepEqual([mara.kind, mara.archetype], ['facilitator', 'facilitator']);
    // Fixed at creation, like every archetype.
    await assert.rejects(
      pool.query(`UPDATE agents SET archetype = 'standard' WHERE slug = 'c1'`),
      (err: { constraint?: string }) => err.constraint === 'agents_archetype_immutable',
    );
    // A registry row that agents reference cannot be removed from under them.
    await assert.rejects(pool.query(`DELETE FROM agent_archetypes WHERE id = 'coach'`));
    await pool.query(`DELETE FROM agents WHERE slug = 'c1'`);
    await pool.query(`DELETE FROM agent_archetypes WHERE id = 'coach'`);
  });
});
