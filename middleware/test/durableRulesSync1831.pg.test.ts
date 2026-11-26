import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';

import { Pool } from 'pg';

import { NeonKnowledgeGraph } from '@omadia/knowledge-graph-neon/dist/neonKnowledgeGraph.js';
import { runGraphMigrations } from '@omadia/knowledge-graph-neon/dist/migrator.js';
import {
  SYSTEM_ACTOR_OMADIA_USER_ID,
  promoteRuleFileToDurable,
  syncDurableRules,
} from '@omadia/orchestrator-extras';

import { probePgTest } from './_helpers/pgTestDb.js';

/**
 * #1831 / #1829 (ADR-0185) — rule entries follow the `_rules/` files, matched
 * on the exact path, and owner-less memorable knowledge can be listed and
 * deleted by an operator. Real Postgres (`npm run test:pg`).
 */

const { url: PG_URL, reachable: pgUp } = await probePgTest({
  label: 'durableRulesSync1831',
  vars: ['GRAPH_PG_TEST_URL', 'MEMORY_PG_TEST_URL'],
  requireVector: true,
});

const TENANT = 'w02-rules-1831';
const OPERATOR = '11111111-2222-4333-8444-555555555555';

if (pgUp) {
  const pool = new Pool({ connectionString: PG_URL });
  const kg = new NeonKnowledgeGraph({ pool, tenantId: TENANT });

  async function rules(): Promise<Array<{ id: string; summary: string; path: string }>> {
    const res = await pool.query<{ id: string; summary: string; rationale: string }>(
      `SELECT external_id AS id, properties->>'summary' AS summary, properties->>'rationale' AS rationale
         FROM graph_nodes
        WHERE tenant_id = $1 AND type = 'MemorableKnowledge' AND manually_authored = true
        ORDER BY properties->>'rationale'`,
      [TENANT],
    );
    return res.rows.map((r) => ({ id: r.id, summary: r.summary, path: r.rationale.split('\n')[0]! }));
  }

  before(async () => {
    await runGraphMigrations(pool);
    await pool.query('DELETE FROM graph_nodes WHERE tenant_id = $1', [TENANT]);
    await pool.query('DELETE FROM memory_acl_audit WHERE tenant_id = $1', [TENANT]);
  });
  after(async () => {
    await pool.query('DELETE FROM graph_nodes WHERE tenant_id = $1', [TENANT]).catch(() => undefined);
    await pool.end();
  });

  describe('#1831 · rule entries follow their files (real PG)', () => {
    it('matches the exact path: a.md.bak does not shadow a.md', async () => {
      const base = { pool, kg, tenantId: TENANT };
      const bak = await promoteRuleFileToDurable({ ...base, virtualPath: '/memories/_rules/a.md.bak', content: 'old rule' });
      assert.equal(bak.action, 'created');
      const a = await promoteRuleFileToDurable({ ...base, virtualPath: '/memories/_rules/a.md', content: 'new rule' });
      assert.equal(a.action, 'created', 'LIKE prefix used to skip this one');
      // `_` is a LIKE wildcard: `/memories/_rules/b_md` must not match `bXmd`.
      await promoteRuleFileToDurable({ ...base, virtualPath: '/memories/_rules/bXmd', content: 'x rule' });
      const b = await promoteRuleFileToDurable({ ...base, virtualPath: '/memories/_rules/b_md', content: 'underscore rule' });
      assert.equal(b.action, 'created');
    });

    it('sync updates a changed rule, keeps an unchanged one and removes a gone one', async () => {
      const before = await rules();
      const aId = before.find((r) => r.path.endsWith('/a.md'))!.id;
      const res = await syncDurableRules({
        pool,
        kg,
        tenantId: TENANT,
        files: [
          { virtualPath: '/memories/_rules/a.md', content: 'Regnerisch' },
          { virtualPath: '/memories/_rules/bXmd', content: 'x rule' },
          { virtualPath: '/memories/_rules/c.md', content: 'brand new' },
          { virtualPath: '/memories/_rules/README.md', content: 'index, not a rule' },
        ],
      });
      assert.deepEqual(res, { created: 1, updated: 1, unchanged: 1, removed: 2, failed: 0 });
      const after = await rules();
      assert.deepEqual(after.map((r) => r.path), [
        'source-memory-path: /memories/_rules/a.md',
        'source-memory-path: /memories/_rules/bXmd',
        'source-memory-path: /memories/_rules/c.md',
      ]);
      const a = after.find((r) => r.path.endsWith('/a.md'))!;
      assert.equal(a.id, aId, 'updated in place');
      assert.equal(a.summary, 'Regnerisch');

      const audit = await pool.query<{ actor: string; action: string }>(
        `SELECT actor_omadia_user_id::text AS actor, action FROM memory_acl_audit WHERE tenant_id = $1 AND action = 'delete'`,
        [TENANT],
      );
      assert.equal(audit.rows.length, 2);
      assert.ok(audit.rows.every((r) => r.actor === SYSTEM_ACTOR_OMADIA_USER_ID && r.action === 'delete'));
    });

    it('no rule files at all keeps the entries (missing seed, not "no rules")', async () => {
      const res = await syncDurableRules({ pool, kg, tenantId: TENANT, files: [] });
      assert.equal(res.removed, 0);
      assert.equal((await rules()).length, 3);
    });

    it('a second sync is a no-op', async () => {
      const res = await syncDurableRules({
        pool,
        kg,
        tenantId: TENANT,
        files: [
          { virtualPath: '/memories/_rules/a.md', content: 'Regnerisch' },
          { virtualPath: '/memories/_rules/bXmd', content: 'x rule' },
          { virtualPath: '/memories/_rules/c.md', content: 'brand new' },
        ],
      });
      assert.deepEqual(res, { created: 0, updated: 0, unchanged: 3, removed: 0, failed: 0 });
    });
  });

  describe('#1829 · owner-less memorable knowledge (real PG)', () => {
    it('lists owner-less entries only and deletes one with an audit row', async () => {
      const ownerless = await kg.createMemorableKnowledge({
        kind: 'insight',
        summary: 'reaper note',
        createdBy: 'scratch-reaper',
        aclOwners: [],
        visibility: 'private',
        originAgent: 'fallback',
      });
      const owned = await kg.createMemorableKnowledge({
        kind: 'insight',
        summary: 'owned note',
        createdBy: 'user',
        aclOwners: [OPERATOR],
      });
      const listed = (await kg.listOwnerlessMemorableKnowledge()).map((n) => n.id);
      assert.ok(listed.includes(ownerless.memorableKnowledgeNodeId));
      assert.ok(!listed.includes(owned.memorableKnowledgeNodeId));

      await assert.rejects(
        () => kg.deleteOwnerlessMemory(owned.memorableKnowledgeNodeId, { actorOmadiaUserId: OPERATOR }),
        { code: 'has_owners' },
      );
      await kg.deleteOwnerlessMemory(ownerless.memorableKnowledgeNodeId, {
        actorOmadiaUserId: OPERATOR,
        reason: 'cleanup',
      });
      assert.equal(await kg.getMemorableKnowledge(ownerless.memorableKnowledgeNodeId), null);
      const trail = await kg.listMemoryAclAudit(ownerless.memorableKnowledgeNodeId);
      assert.equal(trail[0]?.action, 'delete');
      assert.equal(trail[0]?.actorOmadiaUserId, OPERATOR);
      await assert.rejects(
        () => kg.deleteOwnerlessMemory(ownerless.memorableKnowledgeNodeId, { actorOmadiaUserId: OPERATOR }),
        { code: 'memory_not_found' },
      );
    });
  });
}
