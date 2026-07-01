import { strict as assert } from 'node:assert';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';

import { Pool } from 'pg';

import { AgentGraphStore, runMultiOrchestratorMigrations } from '@omadia/orchestrator';

/**
 * PG-gated coverage for the Wave 0 skill-lifecycle store surface:
 * content-hash derivation on write, hash stability on a name-only patch,
 * source/source_path pass-through + immutability on re-upsert, getSkill, and
 * the listSubAgentsBySkillId reverse lookup. Skips when no test Postgres is
 * reachable, mirroring the other pg tests.
 */
const PG_URL =
  process.env['GRAPH_PG_TEST_URL'] ??
  process.env['MEMORY_PG_TEST_URL'] ??
  process.env['WS5_PG_TEST_URL'] ??
  'postgres://test:test@127.0.0.1:55438/test';

const SLUG_PREFIX = 'wave0-skill-test-';
const migrationsDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

const probePool = new Pool({ connectionString: PG_URL, connectionTimeoutMillis: 2000 });
let pgAvailable = true;
try {
  await probePool.query('SELECT 1');
} catch {
  pgAvailable = false;
  await probePool.end().catch(() => undefined);
}

describe('AgentGraphStore skill lifecycle (pg)', { skip: !pgAvailable }, () => {
  const pool = probePool;
  let store: AgentGraphStore;

  before(async () => {
    await runMultiOrchestratorMigrations(pool, undefined, migrationsDir);
    await pool.query('DELETE FROM skills WHERE slug LIKE $1', [`${SLUG_PREFIX}%`]);
    store = new AgentGraphStore(pool);
  });

  after(async () => {
    await pool.query('DELETE FROM skills WHERE slug LIKE $1', [`${SLUG_PREFIX}%`]);
    await pool.end();
  });

  it('derives a content_hash on create', async () => {
    const s = await store.upsertSkill({
      slug: `${SLUG_PREFIX}a`,
      name: 'A',
      body: 'hello',
      frontmatter: { k: 'v' },
    });
    assert.match(s.contentHash ?? '', /^[0-9a-f]{64}$/);
    assert.equal(s.source, 'db');
    assert.equal(s.forkedFrom, null);
  });

  it('re-versions the content_hash when the body changes on re-upsert', async () => {
    const first = await store.upsertSkill({ slug: `${SLUG_PREFIX}b`, name: 'B', body: 'one' });
    const second = await store.upsertSkill({ slug: `${SLUG_PREFIX}b`, name: 'B', body: 'two' });
    assert.equal(second.id, first.id, 'same slug upserts in place');
    assert.notEqual(second.contentHash, first.contentHash);
  });

  it('persists source/source_path and keeps them immutable on re-upsert', async () => {
    const imported = await store.upsertSkill({
      slug: `${SLUG_PREFIX}c`,
      name: 'C',
      body: 'x',
      source: 'file',
      sourcePath: '/skills/c/SKILL.md',
    });
    assert.equal(imported.source, 'file');
    assert.equal(imported.sourcePath, '/skills/c/SKILL.md');

    const again = await store.upsertSkill({ slug: `${SLUG_PREFIX}c`, name: 'C2', body: 'y' });
    assert.equal(again.source, 'file', 'source is immutable across upserts');
    assert.equal(again.sourcePath, '/skills/c/SKILL.md');
  });

  it('keeps content_hash stable on a name-only patch, recomputes on a body patch', async () => {
    const s = await store.upsertSkill({ slug: `${SLUG_PREFIX}d`, name: 'D', body: 'body' });
    const renamed = await store.updateSkill(s.id, { name: 'D-renamed' });
    assert.equal(renamed.contentHash, s.contentHash, 'name-only patch must not stale the hash');

    const edited = await store.updateSkill(s.id, { body: 'body changed' });
    assert.notEqual(edited.contentHash, s.contentHash);
  });

  it('keeps content_hash stable on a name-only patch even with frontmatter (jsonb round-trip)', async () => {
    // Guards against jsonb round-trip drift: the hash recomputed from the
    // stored-then-reread frontmatter must equal the one computed on write.
    const s = await store.upsertSkill({
      slug: `${SLUG_PREFIX}g`,
      name: 'G',
      body: 'body',
      frontmatter: { tags: ['a', 'b'], nested: { x: 1, y: 2 }, flag: true },
    });
    const renamed = await store.updateSkill(s.id, { name: 'G2' });
    assert.equal(renamed.contentHash, s.contentHash);
  });

  it('a fresh upsert and a read-modify-write update converge on the same content_hash', async () => {
    // Cross-path equality: dedup (#391) relies on both write paths agreeing.
    const fm = { role: 'writer', langs: ['de', 'en'] };
    const viaUpsert = await store.upsertSkill({
      slug: `${SLUG_PREFIX}h1`,
      name: 'H1',
      body: 'shared body',
      frontmatter: fm,
    });
    const seed = await store.upsertSkill({ slug: `${SLUG_PREFIX}h2`, name: 'H2', body: 'seed' });
    const viaUpdate = await store.updateSkill(seed.id, { body: 'shared body', frontmatter: fm });
    assert.equal(viaUpdate.contentHash, viaUpsert.contentHash);
  });

  it('getSkill returns the row, or undefined for an unknown id', async () => {
    const s = await store.upsertSkill({ slug: `${SLUG_PREFIX}e`, name: 'E', body: 'z' });
    const found = await store.getSkill(s.id);
    assert.equal(found?.id, s.id);
    const missing = await store.getSkill('00000000-0000-0000-0000-000000000000');
    assert.equal(missing, undefined);
  });

  it('listSubAgentsBySkillId returns [] for a skill no sub-agent references', async () => {
    const s = await store.upsertSkill({ slug: `${SLUG_PREFIX}f`, name: 'F', body: 'q' });
    const usedBy = await store.listSubAgentsBySkillId(s.id);
    assert.deepEqual(usedBy, []);
  });
});
