import { strict as assert } from 'node:assert';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';

import { Pool } from 'pg';

import { AgentGraphStore, runMultiOrchestratorMigrations } from '@omadia/orchestrator';

import { importSkillMarkdown } from '../src/services/skillImport.js';

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

  async function cleanup(): Promise<void> {
    // Delete agents first (cascades sub-agents), then skills.
    await pool.query('DELETE FROM agents WHERE slug LIKE $1', [`${SLUG_PREFIX}%`]);
    await pool.query('DELETE FROM skills WHERE slug LIKE $1', [`${SLUG_PREFIX}%`]);
  }

  before(async () => {
    await runMultiOrchestratorMigrations(pool, undefined, migrationsDir);
    await cleanup();
    store = new AgentGraphStore(pool);
  });

  after(async () => {
    await cleanup();
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

  it('importSkillMarkdown creates, then converges (unchanged) then updates against real PG', async () => {
    const raw = `---\nname: ${SLUG_PREFIX}imp\ndescription: d\n---\n\nbody one\n`;
    const created = await importSkillMarkdown(store, { raw, sourcePath: 'x/SKILL.md' });
    assert.equal(created.outcome, 'created');
    const row = await store.getSkill(created.skillId!);
    assert.equal(row?.source, 'file');
    assert.equal(row?.sourcePath, 'x/SKILL.md');

    const unchanged = await importSkillMarkdown(store, { raw, sourcePath: 'x/SKILL.md' });
    assert.equal(unchanged.outcome, 'unchanged');
    assert.equal(unchanged.skillId, created.skillId);

    const updated = await importSkillMarkdown(store, {
      raw: raw.replace('body one', 'body two'),
      sourcePath: 'x/SKILL.md',
    });
    assert.equal(updated.outcome, 'updated');
    assert.equal(updated.skillId, created.skillId, 'updates in place, no duplicate');
  });

  it('forkSkill copies an imported skill to an editable db skill, migrates refs, preserves provenance', async () => {
    const imp = await importSkillMarkdown(store, {
      raw: `---\nname: ${SLUG_PREFIX}fork\n---\n\nbody\n`,
      sourcePath: 'f/SKILL.md',
    });
    const originId = imp.skillId!;
    const { rows } = await pool.query<{ id: string }>(
      'INSERT INTO agents (slug, name) VALUES ($1,$2) RETURNING id',
      [`${SLUG_PREFIX}agent`, 'A'],
    );
    const sub = await store.createSubAgent({
      parentAgentId: rows[0]!.id,
      name: 'sub',
      skillId: originId,
    });
    assert.equal((await store.listSubAgentsBySkillId(originId)).length, 1);

    await store.replaceSkillResources(originId, [{ name: 'ref.md', content: 'R' }]);

    const fork = await store.forkSkill(originId);
    assert.equal(fork.source, 'db');
    assert.equal(fork.forkedFrom, originId);
    const forkResources = await store.listSkillResources(fork.id);
    assert.equal(forkResources.length, 1, 'fork carries the origin bundle');
    assert.equal(forkResources[0]?.name, 'ref.md');
    assert.notEqual(fork.slug, imp.skill.slug);
    assert.equal(fork.sourcePath, 'f/SKILL.md', 'provenance preserved');
    assert.equal((await store.listSubAgentsBySkillId(originId)).length, 0, 'origin ref migrated away');
    const onFork = await store.listSubAgentsBySkillId(fork.id);
    assert.equal(onFork.length, 1);
    assert.equal(onFork[0]?.id, sub.id);
    assert.notEqual(await store.getSkill(originId), undefined, 'origin kept as provenance record');
  });

  it('forkSkill is idempotent — forking the same import twice returns the same fork', async () => {
    const imp = await importSkillMarkdown(store, {
      raw: `---\nname: ${SLUG_PREFIX}idem\n---\n\nbody\n`,
      sourcePath: 'i/SKILL.md',
    });
    const fork1 = await store.forkSkill(imp.skillId!);
    const fork2 = await store.forkSkill(imp.skillId!);
    assert.equal(fork2.id, fork1.id, 'no duplicate fork minted');
  });

  it('forkSkill returns a db skill unchanged (only file skills fork)', async () => {
    const db = await store.upsertSkill({ slug: `${SLUG_PREFIX}dbfork`, name: 'D', body: 'x', source: 'db' });
    const same = await store.forkSkill(db.id);
    assert.equal(same.id, db.id);
    assert.equal(same.source, 'db');
  });

  it('replaceSkillResources sets, replaces, and cascade-deletes with the skill', async () => {
    const s = await store.upsertSkill({ slug: `${SLUG_PREFIX}res`, name: 'R', body: 'b' });
    await store.replaceSkillResources(s.id, [
      { name: 'a.md', content: 'A' },
      { name: 'b.md', content: 'B' },
    ]);
    let list = await store.listSkillResources(s.id);
    assert.equal(list.length, 2);
    assert.deepEqual(list.map((r) => r.name), ['a.md', 'b.md']);

    // Replace converges (old entries removed).
    await store.replaceSkillResources(s.id, [{ name: 'a.md', content: 'A2' }]);
    list = await store.listSkillResources(s.id);
    assert.equal(list.length, 1);
    assert.equal(list[0]?.content, 'A2');

    // Cascade on skill delete.
    await store.deleteSkill(s.id);
    assert.deepEqual(await store.listSkillResources(s.id), []);
  });

  // ── Wave 8 — direct-answer persona skills ─────────────────────────────────

  async function makeAgent(slug: string): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      'INSERT INTO agents (slug, name) VALUES ($1,$2) RETURNING id',
      [slug, slug],
    );
    return rows[0]!.id;
  }

  it('addPersonaSkill attaches a skill, is idempotent, listPersonaSkills returns it', async () => {
    const agentId = await makeAgent(`${SLUG_PREFIX}persona-agent-a`);
    const s = await store.upsertSkill({ slug: `${SLUG_PREFIX}persona-a`, name: 'PA', body: 'x' });

    const first = await store.addPersonaSkill(agentId, s.id);
    assert.equal(first.agentId, agentId);
    assert.equal(first.skillId, s.id);

    // Idempotent: re-attaching the same link returns the existing row, no dup.
    const again = await store.addPersonaSkill(agentId, s.id);
    assert.equal(again.position, first.position);

    const list = await store.listPersonaSkills(agentId);
    assert.equal(list.length, 1);
    assert.equal(list[0]?.skillId, s.id);
  });

  it('removePersonaSkill detaches without affecting other agents', async () => {
    const agentA = await makeAgent(`${SLUG_PREFIX}persona-agent-b1`);
    const agentB = await makeAgent(`${SLUG_PREFIX}persona-agent-b2`);
    const s = await store.upsertSkill({ slug: `${SLUG_PREFIX}persona-b`, name: 'PB', body: 'x' });

    await store.addPersonaSkill(agentA, s.id);
    await store.addPersonaSkill(agentB, s.id);
    await store.removePersonaSkill(agentA, s.id);

    assert.deepEqual(await store.listPersonaSkills(agentA), []);
    assert.equal((await store.listPersonaSkills(agentB)).length, 1);
  });

  it('listAgentsByPersonaSkillId reflects attach/detach', async () => {
    const agentId = await makeAgent(`${SLUG_PREFIX}persona-agent-c`);
    const s = await store.upsertSkill({ slug: `${SLUG_PREFIX}persona-c`, name: 'PC', body: 'x' });

    assert.deepEqual(await store.listAgentsByPersonaSkillId(s.id), []);
    await store.addPersonaSkill(agentId, s.id);
    assert.deepEqual(await store.listAgentsByPersonaSkillId(s.id), [agentId]);
    await store.removePersonaSkill(agentId, s.id);
    assert.deepEqual(await store.listAgentsByPersonaSkillId(s.id), []);
  });

  it('deleting a skill cascades: the persona link disappears', async () => {
    const agentId = await makeAgent(`${SLUG_PREFIX}persona-agent-d`);
    const s = await store.upsertSkill({ slug: `${SLUG_PREFIX}persona-d`, name: 'PD', body: 'x' });
    await store.addPersonaSkill(agentId, s.id);

    await store.deleteSkill(s.id);
    assert.deepEqual(await store.listPersonaSkills(agentId), []);
  });

  it('deleting an agent cascades: the persona link disappears', async () => {
    const agentId = await makeAgent(`${SLUG_PREFIX}persona-agent-e`);
    const s = await store.upsertSkill({ slug: `${SLUG_PREFIX}persona-e`, name: 'PE', body: 'x' });
    await store.addPersonaSkill(agentId, s.id);

    await pool.query('DELETE FROM agents WHERE id = $1', [agentId]);
    assert.deepEqual(await store.listAgentsByPersonaSkillId(s.id), []);
  });
});
