import { strict as assert } from 'node:assert';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';

import { Pool } from 'pg';

import { AgentGraphStore, runMultiOrchestratorMigrations } from '@omadia/orchestrator';

import { probePgTest } from './_helpers/pgTestDb.js';
import {
  PgSkillOwnershipLifecycleStore,
  SkillLifecycleTransitionRejected,
} from '../src/services/skillLifecycleStore.js';

/**
 * PG-gated coverage for #577 P1's ownership + lifecycle columns
 * (`migrations/0040_skill_ownership_lifecycle.sql`) and their store
 * (`skillLifecycleStore.ts`). Deliberately a SEPARATE file from
 * `skillLifecycleStore.pg.test.ts` (pre-existing, Wave 0 content-hash
 * coverage over `AgentGraphStore.upsertSkill`) so neither suite's fixtures
 * collide. Skips when no test Postgres is reachable, same posture as every
 * other `.pg.test.ts` in this tree.
 */
const SLUG_PREFIX = 'p577-ownership-test-';
const migrationsDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

const { url: PG_URL, reachable: pgAvailable } = await probePgTest({
  label: 'skillOwnershipLifecycleStore',
  vars: ['GRAPH_PG_TEST_URL', 'MEMORY_PG_TEST_URL', 'WS5_PG_TEST_URL'],
});
const probePool = new Pool({ connectionString: PG_URL });

describe('PgSkillOwnershipLifecycleStore (pg)', { skip: !pgAvailable }, () => {
  const pool = probePool;
  let graphStore: AgentGraphStore;
  let store: PgSkillOwnershipLifecycleStore;
  const KEY = 'test-signing-key';

  async function cleanup(): Promise<void> {
    await pool.query('DELETE FROM skills WHERE slug LIKE $1', [`${SLUG_PREFIX}%`]);
  }

  before(async () => {
    await runMultiOrchestratorMigrations(pool, undefined, migrationsDir);
    await cleanup();
    graphStore = new AgentGraphStore(pool);
    store = new PgSkillOwnershipLifecycleStore(pool);
  });

  after(async () => {
    await cleanup();
    await pool.end();
  });

  async function seedDraftSkill(suffix: string, requiredCapabilities: readonly string[] = []): Promise<string> {
    const row = await graphStore.upsertSkill({
      slug: `${SLUG_PREFIX}${suffix}`,
      name: `Skill ${suffix}`,
      body: 'body',
      frontmatter: requiredCapabilities.length > 0 ? { requiredCapabilities } : {},
    });
    return row.id;
  }

  it('a freshly imported skill has no owner and starts in draft', async () => {
    const id = await seedDraftSkill('fresh');
    const row = await store.getSkill(id);
    assert.equal(row?.ownerScope, null);
    assert.equal(row?.lifecycleStatus, 'draft');
    assert.equal(row?.manifestSignature, null);
  });

  it('assignPersonalOwner sets owner_scope on a draft, unowned skill', async () => {
    const id = await seedDraftSkill('assign');
    await store.assignPersonalOwner(id, { kind: 'personal', userId: 'u-1' });
    const row = await store.getSkill(id);
    assert.equal(row?.ownerScope, 'personal:u-1');
  });

  it('refuses to reassign an already-owned skill', async () => {
    const id = await seedDraftSkill('reassign');
    await store.assignPersonalOwner(id, { kind: 'personal', userId: 'u-1' });
    await assert.rejects(
      () => store.assignPersonalOwner(id, { kind: 'personal', userId: 'u-2' }),
      /already has an owner scope/,
    );
    const row = await store.getSkill(id);
    assert.equal(row?.ownerScope, 'personal:u-1', 'original owner is untouched');
  });

  it('transition() throws SkillLifecycleTransitionRejected on an unowned skill', async () => {
    const id = await seedDraftSkill('unowned');
    await assert.rejects(
      () => store.transition(id, 'reviewed', { granted: new Set(), signingKey: KEY }),
      (err: unknown) => {
        assert.ok(err instanceof SkillLifecycleTransitionRejected);
        assert.equal(err.reason, 'invalid-owner-scope');
        return true;
      },
    );
  });

  it('draft -> reviewed -> published -> archived signs at each step and persists the new status', async () => {
    const id = await seedDraftSkill('lifecycle', ['mcp.web-search']);
    await store.assignPersonalOwner(id, { kind: 'personal', userId: 'u-lifecycle' });

    const reviewed = await store.transition(id, 'reviewed', { granted: new Set(), signingKey: KEY });
    assert.equal(reviewed.lifecycleStatus, 'reviewed');
    assert.ok(reviewed.manifestSignature);
    assert.ok(reviewed.manifestSignedAt instanceof Date);

    // Publish is blocked until the required capability is granted.
    await assert.rejects(
      () => store.transition(id, 'published', { granted: new Set(), signingKey: KEY }),
      (err: unknown) => {
        assert.ok(err instanceof SkillLifecycleTransitionRejected);
        assert.equal(err.reason, 'missing-capabilities');
        assert.deepEqual(err.missing, ['mcp.web-search']);
        return true;
      },
    );
    const stillReviewed = await store.getSkill(id);
    assert.equal(stillReviewed?.lifecycleStatus, 'reviewed', 'rejected transition does not mutate status');

    const published = await store.transition(id, 'published', {
      granted: new Set(['mcp.web-search']),
      signingKey: KEY,
    });
    assert.equal(published.lifecycleStatus, 'published');
    assert.notEqual(published.manifestSignature, reviewed.manifestSignature, 're-signed at the new status');

    const archived = await store.transition(id, 'archived', { granted: new Set(), signingKey: KEY });
    assert.equal(archived.lifecycleStatus, 'archived');

    await assert.rejects(
      () => store.transition(id, 'draft', { granted: new Set(), signingKey: KEY }),
      (err: unknown) => {
        assert.ok(err instanceof SkillLifecycleTransitionRejected);
        assert.equal(err.reason, 'invalid-transition');
        return true;
      },
      'archived is terminal',
    );
  });

  it('a re-signed manifest changes when the underlying skill body changes (content_hash drift)', async () => {
    const id = await seedDraftSkill('drift');
    await store.assignPersonalOwner(id, { kind: 'personal', userId: 'u-drift' });
    const before1 = await store.transition(id, 'reviewed', { granted: new Set(), signingKey: KEY });

    // Edit the body directly (bypassing the store, as an operator edit would).
    await graphStore.updateSkill(id, { body: 'a very different body' });

    const back = await store.transition(id, 'draft', { granted: new Set(), signingKey: KEY });
    assert.notEqual(back.manifestSignature, before1.manifestSignature, 'signature tracks content_hash drift');
  });
});
