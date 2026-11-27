/**
 * #1842 / #1843 (ADR-0186) — the Neon side of a user erasure, against a real
 * pgvector Postgres (`GRAPH_PG_TEST_URL`; skipped without one): shared
 * memorable knowledge is de-owned with an audit row, sole-owned entries go
 * with their excerpts and are counted, identity nodes and the processes a
 * person created are deleted, and a channel identity resolves to its person.
 */
import { strict as assert } from 'node:assert';
import { after, describe, it } from 'node:test';

import { Pool } from 'pg';

import { NeonKnowledgeGraph } from '@omadia/knowledge-graph-neon/dist/neonKnowledgeGraph.js';
import { runGraphMigrations } from '@omadia/knowledge-graph-neon/dist/migrator.js';
import { NeonProcessMemoryStore } from '@omadia/knowledge-graph-neon/dist/processMemoryStore.js';
import type { EmbeddingClient } from '@omadia/plugin-api';

import { probePgTest } from './_helpers/pgTestDb.js';

const TENANT = 'w02-user-erasure';
const OPERATOR = '0b6f2c1e-1111-4222-8333-944455556666';

const embedder: EmbeddingClient = {
  async embed(text: string) {
    const v = Array.from({ length: 768 }, () => 0);
    v[text.length % 768] = 1;
    return v;
  },
} as unknown as EmbeddingClient;

const { url: PG_URL, reachable: pgUp } = await probePgTest({
  label: 'memoryPurgeUserErasure',
  vars: ['GRAPH_PG_TEST_URL', 'KG_PG_TEST_URL', 'MEMORY_PG_TEST_URL'],
  requireVector: true,
});
const pool = pgUp ? new Pool({ connectionString: PG_URL }) : undefined;

async function wipe(p: Pool): Promise<void> {
  await p.query('DELETE FROM process_history WHERE tenant_id = $1', [TENANT]);
  await p.query('DELETE FROM processes WHERE tenant_id = $1', [TENANT]);
  await p.query('DELETE FROM graph_nodes WHERE tenant_id = $1', [TENANT]);
  await p.query('DELETE FROM memory_acl_audit WHERE tenant_id = $1', [TENANT]);
}

after(async () => {
  if (!pool) return;
  await wipe(pool);
  await pool.end();
});

describe('#1842/#1843 · user erasure on Neon (real PG)', () => {
  it('de-owns shared entries, deletes sole-owned ones with excerpts, and the identity', async (t) => {
    if (!pool) return t.skip('no test database');
    await runGraphMigrations(pool);
    await wipe(pool);
    const kg = new NeonKnowledgeGraph({ pool, tenantId: TENANT });
    const bea = await kg.resolveOrCreateChannelIdentity({
      channelKind: 'telegram',
      channelUserId: '4711',
      displayName: 'Bea',
      email: 'bea@example.com',
      emailVerified: true,
    });
    const alice = await kg.resolveOrCreateChannelIdentity({ channelKind: 'web', channelUserId: 'acc-alice' });
    assert.equal(await kg.findOmadiaUserIdByChannelIdentity('telegram', '4711'), bea.omadiaUserId);
    assert.equal(await kg.findOmadiaUserIdByChannelIdentity('telegram', 'nope'), null);

    const own = await kg.createMemorableKnowledge({
      kind: 'insight',
      summary: 'Bea alone',
      aclOwners: [bea.omadiaUserId],
      createdBy: 'test',
      palaiaExcerpts: { texts: ['one', 'two'], source: 'hint' },
    });
    const shared = await kg.createMemorableKnowledge({
      kind: 'decision',
      summary: 'Project Dolphin starts in January.',
      aclOwners: [alice.omadiaUserId, bea.omadiaUserId],
      createdBy: 'test',
    });
    const filter = { tenantId: TENANT, aclOwner: bea.omadiaUserId, actorOmadiaUserId: OPERATOR };
    assert.deepEqual(await kg.countMemorableKnowledge(filter), { count: 1, deowned: 1, excerpts: 2 });
    assert.deepEqual(await kg.purgeMemorableKnowledge(filter), {
      deletedNodes: 1,
      deownedNodes: 1,
      deletedExcerpts: 2,
    });
    assert.equal(await kg.getMemorableKnowledge(own.memorableKnowledgeNodeId), null);
    const kept = await kg.getMemorableKnowledge(shared.memorableKnowledgeNodeId, alice.omadiaUserId);
    assert.deepEqual(kept?.props['acl_owners'], [alice.omadiaUserId]);
    const trail = await kg.listMemoryAclAudit(shared.memorableKnowledgeNodeId);
    assert.equal(trail[0]?.action, 'shrink');
    assert.equal(trail[0]?.actorOmadiaUserId, OPERATOR);

    assert.equal((await kg.countUserIdentity(bea.omadiaUserId)).count, 2);
    // #2293 — the purge reads the identities before it deletes them.
    assert.deepEqual(await kg.listUserChannelIdentities(bea.omadiaUserId), [
      { channelKind: 'telegram', channelUserId: '4711' },
    ]);
    assert.deepEqual(await kg.listUserChannelIdentities(alice.omadiaUserId), [
      { channelKind: 'web', channelUserId: 'acc-alice' },
    ]);
    assert.equal((await kg.purgeUserIdentity(bea.omadiaUserId)).deletedNodes, 2);
    assert.deepEqual(await kg.listUserChannelIdentities(bea.omadiaUserId), []);
    assert.equal((await kg.countUserIdentity(bea.omadiaUserId)).count, 0);
    assert.equal(await kg.findOmadiaUserIdByChannelIdentity('telegram', '4711'), null);
    assert.equal((await kg.countUserIdentity(alice.omadiaUserId)).count, 2, 'Alice untouched');
  });

  it('#2279 — reaches memory owned by the AAD object id of a Teams identity', async (t) => {
    if (!pool) return t.skip('no test database');
    await runGraphMigrations(pool);
    await wipe(pool);
    const kg = new NeonKnowledgeGraph({ pool, tenantId: TENANT });
    const aad = 'aad0aad0-2279-4222-8333-000000002279';
    const bea = await kg.resolveOrCreateChannelIdentity({
      channelKind: 'teams',
      channelUserId: '29:teams-bea',
      aadObjectId: aad,
      displayName: 'Bea',
    });
    const alice = await kg.resolveOrCreateChannelIdentity({ channelKind: 'web', channelUserId: 'acc-alice' });
    // Teams auto-promotion owns a memory by the raw channel id (the AAD id).
    const alone = await kg.createMemorableKnowledge({
      kind: 'insight',
      summary: 'Bea alone, from Teams',
      aclOwners: [aad],
      createdBy: 'test',
      palaiaExcerpts: { texts: ['one'], source: 'hint' },
    });
    const both = await kg.createMemorableKnowledge({
      kind: 'insight',
      summary: 'Bea in both forms',
      aclOwners: [bea.omadiaUserId, aad],
      createdBy: 'test',
    });
    const shared = await kg.createMemorableKnowledge({
      kind: 'decision',
      summary: 'Teams room: Dolphin starts in January.',
      aclOwners: [alice.omadiaUserId, aad, bea.omadiaUserId],
      createdBy: 'test',
    });
    const aliceOwn = await kg.createMemorableKnowledge({
      kind: 'insight',
      summary: 'Alice alone',
      aclOwners: [alice.omadiaUserId],
      createdBy: 'test',
    });
    const filter = { tenantId: TENANT, aclOwner: bea.omadiaUserId, actorOmadiaUserId: OPERATOR };
    assert.deepEqual(await kg.countMemorableKnowledge(filter), { count: 2, deowned: 1, excerpts: 1 });
    assert.deepEqual(await kg.purgeMemorableKnowledge(filter), {
      deletedNodes: 2,
      deownedNodes: 1,
      deletedExcerpts: 1,
    });
    assert.equal(await kg.getMemorableKnowledge(alone.memorableKnowledgeNodeId), null);
    assert.equal(await kg.getMemorableKnowledge(both.memorableKnowledgeNodeId), null);
    const kept = await kg.getMemorableKnowledge(shared.memorableKnowledgeNodeId, alice.omadiaUserId);
    assert.deepEqual(kept?.props['acl_owners'], [alice.omadiaUserId], 'both of Bea’s ids are gone');
    assert.notEqual(
      await kg.getMemorableKnowledge(aliceOwn.memorableKnowledgeNodeId, alice.omadiaUserId),
      null,
      'Alice’s own entry is untouched',
    );
  });

  it('records who created a process and purges exactly those, history included', async (t) => {
    if (!pool) return t.skip('no test database');
    await runGraphMigrations(pool);
    await wipe(pool);
    const store = new NeonProcessMemoryStore({ pool, tenantId: TENANT, resolveEmbeddingClient: () => embedder });
    const mine = await store.write({
      title: 'Einkauf: Linsen bestellen',
      steps: ['Lieferant anrufen'],
      scope: 's',
      createdByOmadiaUserId: 'bea',
    });
    const other = await store.write({ title: 'Backend: Deploy to staging long title', steps: ['deploy'], scope: 's' });
    assert.ok(mine.ok && other.ok);
    const edited = await store.edit({ id: mine.record.id, steps: ['Lieferant anrufen', 'Menge nennen'] });
    assert.ok(edited.ok);
    assert.equal((await store.history(mine.record.id)).length, 1);

    assert.deepEqual(await store.countByCreator('bea'), { count: 1 });
    assert.deepEqual(await store.purgeByCreator('bea'), { deleted: 1 });
    assert.equal(await store.get(mine.record.id), null);
    assert.equal((await store.history(mine.record.id)).length, 0);
    assert.notEqual(await store.get(other.record.id), null, 'a process without a creator stays');
  });
});
