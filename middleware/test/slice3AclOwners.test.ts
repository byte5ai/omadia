import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, it } from 'node:test';

import { InMemoryKnowledgeGraph } from '@omadia/knowledge-graph-inmemory';

/**
 * Slice 3 — ACL owners + audit on MemorableKnowledge.
 *
 * Surfaces:
 *   1. Migration 0018 declares the GIN index + audit table without an FK
 *      on graph_nodes (rows must survive memory delete).
 *   2. InMemory ACL filter: viewer must be in `acl_owners`; empty owners
 *      are invisible to everyone (admin-only / Decision-Lock L_s3.8).
 *   3. addOwner/removeOwner/deleteMemory: actor must be an owner;
 *      removeOwner protects the last owner; audit-row written each
 *      mutation; deleteMemory writes audit BEFORE drop.
 */

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATION_PATH = join(
  here,
  '..',
  'packages',
  'harness-knowledge-graph-neon',
  'src',
  'migrations',
  '0018_acl_owners.sql',
);

const ALICE = '11111111-2222-3333-4444-555555555555';
const BOB = '99999999-8888-7777-6666-aaaaaaaaaaaa';
const CAROL = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

describe('Slice 3 · migration 0018 SQL file', () => {
  it('runs in a single transaction', async () => {
    const sql = await readFile(MIGRATION_PATH, 'utf8');
    assert.match(sql, /^BEGIN;/m);
    assert.match(sql, /^COMMIT;/m);
  });

  it('declares the GIN index on properties->acl_owners', async () => {
    const sql = await readFile(MIGRATION_PATH, 'utf8');
    assert.match(sql, /CREATE INDEX IF NOT EXISTS idx_memorable_acl_owners/);
    assert.match(sql, /USING gin \(\(properties->'acl_owners'\)\)/);
    assert.match(sql, /WHERE type = 'MemorableKnowledge'/);
  });

  it('declares the audit table WITHOUT FK on graph_nodes', async () => {
    const sql = await readFile(MIGRATION_PATH, 'utf8');
    assert.match(sql, /CREATE TABLE IF NOT EXISTS memory_acl_audit/);
    assert.doesNotMatch(
      sql,
      /memory_external_id\s+\w+\s+NOT NULL\s+REFERENCES/i,
      'audit table must NOT reference graph_nodes — audit survives delete',
    );
  });

  it('declares the audit action check constraint', async () => {
    const sql = await readFile(MIGRATION_PATH, 'utf8');
    assert.match(
      sql,
      /CONSTRAINT memory_acl_audit_action_chk CHECK \([\s\S]*'create'[\s\S]*'expand'[\s\S]*'shrink'[\s\S]*'delete'/,
    );
  });
});

async function seedClusters(
  kg: InMemoryKnowledgeGraph,
): Promise<Record<'alice' | 'bob' | 'carol', string>> {
  const a = await kg.resolveOrCreateChannelIdentity({
    channelKind: 'web',
    channelUserId: 'alice-row',
    aadObjectId: ALICE,
  });
  const b = await kg.resolveOrCreateChannelIdentity({
    channelKind: 'web',
    channelUserId: 'bob-row',
    aadObjectId: BOB,
  });
  const c = await kg.resolveOrCreateChannelIdentity({
    channelKind: 'web',
    channelUserId: 'carol-row',
    aadObjectId: CAROL,
  });
  return { alice: a.omadiaUserId, bob: b.omadiaUserId, carol: c.omadiaUserId };
}

describe('Slice 3 · InMemory ACL filter on get/list', () => {
  let kg: InMemoryKnowledgeGraph;
  let ids: Record<'alice' | 'bob' | 'carol', string>;

  beforeEach(async () => {
    kg = new InMemoryKnowledgeGraph();
    ids = await seedClusters(kg);
  });

  it('get with viewer in acl_owners returns the node', async () => {
    const { memorableKnowledgeNodeId } = await kg.createMemorableKnowledge({
      kind: 'decision',
      summary: 'shared',
      createdBy: 'web:alice-row',
      aclOwners: [ids.alice, ids.bob],
      involvedOmadiaUserIds: [ids.alice],
    });
    const node = await kg.getMemorableKnowledge(
      memorableKnowledgeNodeId,
      ids.alice,
    );
    assert.ok(node);
    assert.equal(node?.type, 'MemorableKnowledge');
  });

  it('get with viewer NOT in acl_owners returns null', async () => {
    const { memorableKnowledgeNodeId } = await kg.createMemorableKnowledge({
      kind: 'decision',
      summary: 'private to alice',
      createdBy: 'web:alice-row',
      aclOwners: [ids.alice],
    });
    const node = await kg.getMemorableKnowledge(
      memorableKnowledgeNodeId,
      ids.bob,
    );
    assert.equal(node, null);
  });

  it('get with empty acl_owners returns null even for non-viewer-mode callers? — empty owners means admin-only', async () => {
    const { memorableKnowledgeNodeId } = await kg.createMemorableKnowledge({
      kind: 'decision',
      summary: 'orphan',
      createdBy: 'web:alice-row',
      // aclOwners omitted -> []
    });
    // Any viewer ID returns null:
    assert.equal(
      await kg.getMemorableKnowledge(memorableKnowledgeNodeId, ids.alice),
      null,
    );
    // No-viewer mode (internal/admin bypass) still returns the node:
    const adminView = await kg.getMemorableKnowledge(memorableKnowledgeNodeId);
    assert.ok(adminView);
  });

  it('list filters by ACL (INVOLVED ∩ acl_owners)', async () => {
    // Alice involved + alice in acl_owners → visible
    await kg.createMemorableKnowledge({
      kind: 'decision',
      summary: 'A1',
      createdBy: 'web:alice-row',
      involvedOmadiaUserIds: [ids.alice],
      aclOwners: [ids.alice],
    });
    // Alice involved but NOT in acl_owners → hidden
    await kg.createMemorableKnowledge({
      kind: 'decision',
      summary: 'A2',
      createdBy: 'web:bob-row',
      involvedOmadiaUserIds: [ids.alice],
      aclOwners: [ids.bob],
    });
    // Bob involved + bob in acl_owners → visible to bob, hidden from alice
    await kg.createMemorableKnowledge({
      kind: 'decision',
      summary: 'B1',
      createdBy: 'web:bob-row',
      involvedOmadiaUserIds: [ids.bob],
      aclOwners: [ids.bob],
    });
    const forAlice = await kg.listMemorableKnowledgeFor(ids.alice);
    assert.equal(forAlice.length, 1);
    assert.equal(forAlice[0]?.props['summary'], 'A1');
    const forBob = await kg.listMemorableKnowledgeFor(ids.bob);
    assert.equal(forBob.length, 1);
    assert.equal(forBob[0]?.props['summary'], 'B1');
  });
});

describe('Slice 3 · InMemory addOwner / removeOwner / deleteMemory', () => {
  let kg: InMemoryKnowledgeGraph;
  let ids: Record<'alice' | 'bob' | 'carol', string>;

  beforeEach(async () => {
    kg = new InMemoryKnowledgeGraph();
    ids = await seedClusters(kg);
  });

  it('addOwner appends + audits expand', async () => {
    const { memorableKnowledgeNodeId } = await kg.createMemorableKnowledge({
      kind: 'preference',
      summary: 'X',
      createdBy: 'web:alice-row',
      aclOwners: [ids.alice],
      actorOmadiaUserId: ids.alice,
    });
    const next = await kg.addOwner(memorableKnowledgeNodeId, ids.bob, {
      actorOmadiaUserId: ids.alice,
      actorChannelIdentityId: 'web:alice-row',
      reason: 'share with bob',
    });
    assert.deepEqual(next, [ids.alice, ids.bob]);

    const audit = await kg.listMemoryAclAudit(memorableKnowledgeNodeId);
    // newest-first; expect [expand, create]
    assert.equal(audit.length, 2);
    assert.equal(audit[0]?.action, 'expand');
    assert.deepEqual(audit[0]?.beforeOwners, [ids.alice]);
    assert.deepEqual(audit[0]?.afterOwners, [ids.alice, ids.bob]);
    assert.equal(audit[0]?.reason, 'share with bob');
    assert.equal(audit[1]?.action, 'create');
  });

  it('addOwner by non-owner throws not_an_owner', async () => {
    const { memorableKnowledgeNodeId } = await kg.createMemorableKnowledge({
      kind: 'preference',
      summary: 'X',
      createdBy: 'web:alice-row',
      aclOwners: [ids.alice],
    });
    await assert.rejects(
      kg.addOwner(memorableKnowledgeNodeId, ids.carol, {
        actorOmadiaUserId: ids.bob, // bob isn't an owner
      }),
      /not_an_owner/,
    );
  });

  it('removeOwner shrinks + audits', async () => {
    const { memorableKnowledgeNodeId } = await kg.createMemorableKnowledge({
      kind: 'preference',
      summary: 'X',
      createdBy: 'web:alice-row',
      aclOwners: [ids.alice, ids.bob],
    });
    const next = await kg.removeOwner(memorableKnowledgeNodeId, ids.bob, {
      actorOmadiaUserId: ids.alice,
    });
    assert.deepEqual(next, [ids.alice]);
    const audit = await kg.listMemoryAclAudit(memorableKnowledgeNodeId);
    assert.equal(audit[0]?.action, 'shrink');
    assert.deepEqual(audit[0]?.afterOwners, [ids.alice]);
  });

  it('removeOwner refuses to drop the last owner', async () => {
    const { memorableKnowledgeNodeId } = await kg.createMemorableKnowledge({
      kind: 'preference',
      summary: 'X',
      createdBy: 'web:alice-row',
      aclOwners: [ids.alice],
    });
    await assert.rejects(
      kg.removeOwner(memorableKnowledgeNodeId, ids.alice, {
        actorOmadiaUserId: ids.alice,
      }),
      /cannot_remove_last_owner/,
    );
  });

  it('removeOwner is no-op + audits when target is not in owners', async () => {
    const { memorableKnowledgeNodeId } = await kg.createMemorableKnowledge({
      kind: 'preference',
      summary: 'X',
      createdBy: 'web:alice-row',
      aclOwners: [ids.alice, ids.bob],
    });
    const next = await kg.removeOwner(memorableKnowledgeNodeId, ids.carol, {
      actorOmadiaUserId: ids.alice,
    });
    assert.deepEqual(next, [ids.alice, ids.bob]);
    const audit = await kg.listMemoryAclAudit(memorableKnowledgeNodeId);
    // Still writes a shrink-row even though nothing changed — this keeps
    // the audit trail explicit about every requested mutation.
    assert.equal(audit[0]?.action, 'shrink');
  });

  it('deleteMemory by owner removes node + audits BEFORE delete', async () => {
    const { memorableKnowledgeNodeId } = await kg.createMemorableKnowledge({
      kind: 'preference',
      summary: 'X',
      createdBy: 'web:alice-row',
      aclOwners: [ids.alice, ids.bob],
    });
    await kg.deleteMemory(memorableKnowledgeNodeId, {
      actorOmadiaUserId: ids.alice,
      reason: 'no longer relevant',
    });
    const node = await kg.getMemorableKnowledge(memorableKnowledgeNodeId);
    assert.equal(node, null);
    // Audit survives.
    const audit = await kg.listMemoryAclAudit(memorableKnowledgeNodeId);
    assert.equal(audit[0]?.action, 'delete');
    assert.deepEqual(audit[0]?.beforeOwners, [ids.alice, ids.bob]);
    assert.equal(audit[0]?.afterOwners, null);
    assert.equal(audit[0]?.reason, 'no longer relevant');
  });

  it('deleteMemory by non-owner throws not_an_owner', async () => {
    const { memorableKnowledgeNodeId } = await kg.createMemorableKnowledge({
      kind: 'preference',
      summary: 'X',
      createdBy: 'web:alice-row',
      aclOwners: [ids.alice],
    });
    await assert.rejects(
      kg.deleteMemory(memorableKnowledgeNodeId, { actorOmadiaUserId: ids.bob }),
      /not_an_owner/,
    );
    const stillThere = await kg.getMemorableKnowledge(memorableKnowledgeNodeId);
    assert.ok(stillThere);
  });

  it('addOwner is idempotent for existing owner', async () => {
    const { memorableKnowledgeNodeId } = await kg.createMemorableKnowledge({
      kind: 'preference',
      summary: 'X',
      createdBy: 'web:alice-row',
      aclOwners: [ids.alice, ids.bob],
    });
    const next = await kg.addOwner(memorableKnowledgeNodeId, ids.bob, {
      actorOmadiaUserId: ids.alice,
    });
    assert.deepEqual(next, [ids.alice, ids.bob]);
  });
});
