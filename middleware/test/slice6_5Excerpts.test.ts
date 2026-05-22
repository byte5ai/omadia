import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { InMemoryKnowledgeGraph } from '@omadia/knowledge-graph-inmemory';
import {
  EXCERPT_SOURCES,
  GRAPH_EDGE_TYPES,
  GRAPH_NODE_TYPES,
  validateNodeProps,
} from '@omadia/knowledge-graph-neon';

/**
 * Slice 6.5 — PalaiaExcerpt persistence + edit + cascade.
 *
 * Backend covered here:
 *   1. Migrations 0020 + 0021 SQL files declare the expected indexes /
 *      CHECK constraints / additive ACL action.
 *   2. Schema enums + Zod props admit the new node + edge types.
 *   3. InMemory KG round-trips: create-with-excerpts → list, update,
 *      cascade-delete, hard-cap rejection, missing-excerpt lookup.
 *
 * Auth / route-side semantics (PATCH 403 for non-owners, etc.) are
 * exercised by the slice-6_5-excerpts.ts smoke against the live API.
 */

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(
  here,
  '..',
  'packages',
  'harness-knowledge-graph-neon',
  'src',
  'migrations',
);

describe('Slice 6.5 · migration 0020 SQL file', () => {
  it('runs in a single transaction', async () => {
    const sql = await readFile(join(MIGRATIONS_DIR, '0020_palaia_excerpts.sql'), 'utf8');
    assert.match(sql, /^BEGIN;/m);
    assert.match(sql, /^COMMIT;/m);
  });

  it('declares the EXCERPT_OF lookup index', async () => {
    const sql = await readFile(join(MIGRATIONS_DIR, '0020_palaia_excerpts.sql'), 'utf8');
    assert.match(sql, /CREATE INDEX IF NOT EXISTS graph_edges_excerpt_of_idx/);
    assert.match(sql, /WHERE type = 'EXCERPT_OF'/);
  });

  it('declares the position-range CHECK on PalaiaExcerpt', async () => {
    const sql = await readFile(join(MIGRATIONS_DIR, '0020_palaia_excerpts.sql'), 'utf8');
    assert.match(sql, /graph_nodes_palaia_excerpt_position_chk/);
    assert.match(sql, /BETWEEN 0 AND 4/);
  });
});

describe('Slice 6.5 · migration 0021 SQL file', () => {
  it('extends the audit-action CHECK with edit_excerpt', async () => {
    const sql = await readFile(
      join(MIGRATIONS_DIR, '0021_acl_audit_edit_excerpt.sql'),
      'utf8',
    );
    assert.match(sql, /memory_acl_audit_action_chk/);
    assert.match(
      sql,
      /'create',\s*'expand',\s*'shrink',\s*'delete',\s*'edit',\s*'edit_excerpt'/,
    );
  });
});

describe('Slice 6.5 · schema enums + Zod props', () => {
  it('GRAPH_NODE_TYPES contains PalaiaExcerpt', () => {
    assert.ok(GRAPH_NODE_TYPES.includes('PalaiaExcerpt'));
  });
  it('GRAPH_EDGE_TYPES contains EXCERPT_OF', () => {
    assert.ok(GRAPH_EDGE_TYPES.includes('EXCERPT_OF'));
  });
  it('EXCERPT_SOURCES exposes the three documented variants', () => {
    assert.deepEqual([...EXCERPT_SOURCES], ['llm', 'hint', 'fallback']);
  });
  it('validateNodeProps accepts a well-formed PalaiaExcerpt props bag', () => {
    const props = {
      text: 'On-Page-Note D, 6 H1-Tags',
      position: 2,
      source: 'llm' as const,
      created_at: new Date().toISOString(),
    };
    const out = validateNodeProps('PalaiaExcerpt', props);
    assert.equal(out['text'], props.text);
    assert.equal(out['position'], 2);
  });
  it('validateNodeProps rejects an out-of-range position', () => {
    assert.throws(() =>
      validateNodeProps('PalaiaExcerpt', {
        text: 'x',
        position: 5,
        source: 'llm',
        created_at: new Date().toISOString(),
      }),
    );
  });
  it('validateNodeProps rejects an over-long excerpt text', () => {
    assert.throws(() =>
      validateNodeProps('PalaiaExcerpt', {
        text: 'x'.repeat(301),
        position: 0,
        source: 'llm',
        created_at: new Date().toISOString(),
      }),
    );
  });
});

const ALICE = '11111111-1111-1111-1111-111111111111';
const BOB = '22222222-2222-2222-2222-222222222222';

async function seedAliceCluster(kg: InMemoryKnowledgeGraph): Promise<string> {
  const cluster = await kg.resolveOrCreateChannelIdentity({
    channelKind: 'web',
    channelUserId: ALICE,
    displayName: 'Alice',
    email: 'alice@example.com',
    emailVerified: true,
  });
  return cluster.omadiaUserId;
}

describe('Slice 6.5 · InMemory KG round-trip', () => {
  it('createMemorableKnowledge with no excerpts yields an empty list', async () => {
    const kg = new InMemoryKnowledgeGraph();
    const owner = await seedAliceCluster(kg);
    const created = await kg.createMemorableKnowledge({
      kind: 'insight',
      summary: 'no excerpts here',
      createdBy: `web:${owner}`,
      involvedOmadiaUserIds: [owner],
      aclOwners: [owner],
    });
    const items = await kg.listExcerptsForMemory(created.memorableKnowledgeNodeId);
    assert.equal(items.length, 0);
  });

  it('persists 3 excerpts in document order with stable position', async () => {
    const kg = new InMemoryKnowledgeGraph();
    const owner = await seedAliceCluster(kg);
    const created = await kg.createMemorableKnowledge({
      kind: 'reference',
      summary: 'with excerpts',
      createdBy: `web:${owner}`,
      involvedOmadiaUserIds: [owner],
      aclOwners: [owner],
      palaiaExcerpts: {
        texts: ['first quote', 'second quote', 'third quote'],
        source: 'llm',
      },
    });
    const items = await kg.listExcerptsForMemory(created.memorableKnowledgeNodeId);
    assert.equal(items.length, 3);
    assert.deepEqual(
      items.map((e) => e.props.position),
      [0, 1, 2],
    );
    assert.deepEqual(
      items.map((e) => e.props.text),
      ['first quote', 'second quote', 'third quote'],
    );
    assert.ok(items.every((e) => e.props.source === 'llm'));
  });

  it('rejects an excerpt batch larger than 5 with excerpt_count_exceeded', async () => {
    const kg = new InMemoryKnowledgeGraph();
    const owner = await seedAliceCluster(kg);
    await assert.rejects(
      kg.createMemorableKnowledge({
        kind: 'insight',
        summary: 'too many',
        createdBy: `web:${owner}`,
        involvedOmadiaUserIds: [owner],
        aclOwners: [owner],
        palaiaExcerpts: {
          texts: ['a', 'b', 'c', 'd', 'e', 'f'],
          source: 'llm',
        },
      }),
      (err: { code?: string }) => err.code === 'excerpt_count_exceeded',
    );
  });

  it('rejects an excerpt longer than 300 chars with excerpt_text_too_long', async () => {
    const kg = new InMemoryKnowledgeGraph();
    const owner = await seedAliceCluster(kg);
    await assert.rejects(
      kg.createMemorableKnowledge({
        kind: 'insight',
        summary: 'too long',
        createdBy: `web:${owner}`,
        involvedOmadiaUserIds: [owner],
        aclOwners: [owner],
        palaiaExcerpts: {
          texts: ['x'.repeat(301)],
          source: 'llm',
        },
      }),
      (err: { code?: string }) => err.code === 'excerpt_text_too_long',
    );
  });

  it('updateExcerpt persists text + writes edit_excerpt audit row with unchanged owners', async () => {
    const kg = new InMemoryKnowledgeGraph();
    const owner = await seedAliceCluster(kg);
    const created = await kg.createMemorableKnowledge({
      kind: 'insight',
      summary: 'patchable',
      createdBy: `web:${owner}`,
      involvedOmadiaUserIds: [owner],
      aclOwners: [owner],
      palaiaExcerpts: { texts: ['original text'], source: 'llm' },
    });
    const updated = await kg.updateExcerpt(
      created.memorableKnowledgeNodeId,
      0,
      { text: 'edited text' },
      { actorOmadiaUserId: owner, reason: 'fix typo' },
    );
    assert.equal(updated.props.text, 'edited text');
    assert.equal(updated.props.position, 0);

    const audit = await kg.listMemoryAclAudit(created.memorableKnowledgeNodeId);
    const editRow = audit.find((r) => r.action === 'edit_excerpt');
    assert.ok(editRow, 'expected an edit_excerpt audit row');
    assert.deepEqual(editRow.beforeOwners, editRow.afterOwners);
    assert.equal(editRow.reason, 'fix typo');
  });

  it('updateExcerpt rejects empty patch with empty_patch', async () => {
    const kg = new InMemoryKnowledgeGraph();
    const owner = await seedAliceCluster(kg);
    const created = await kg.createMemorableKnowledge({
      kind: 'insight',
      summary: 'patchable',
      createdBy: `web:${owner}`,
      involvedOmadiaUserIds: [owner],
      aclOwners: [owner],
      palaiaExcerpts: { texts: ['x'], source: 'llm' },
    });
    await assert.rejects(
      kg.updateExcerpt(
        created.memorableKnowledgeNodeId,
        0,
        {},
        { actorOmadiaUserId: owner },
      ),
      (err: { code?: string }) => err.code === 'empty_patch',
    );
  });

  it('updateExcerpt rejects non-owner actor with not_an_owner', async () => {
    const kg = new InMemoryKnowledgeGraph();
    const owner = await seedAliceCluster(kg);
    const created = await kg.createMemorableKnowledge({
      kind: 'insight',
      summary: 'gated',
      createdBy: `web:${owner}`,
      involvedOmadiaUserIds: [owner],
      aclOwners: [owner],
      palaiaExcerpts: { texts: ['x'], source: 'llm' },
    });
    await assert.rejects(
      kg.updateExcerpt(
        created.memorableKnowledgeNodeId,
        0,
        { text: 'attempted' },
        { actorOmadiaUserId: BOB },
      ),
      (err: { code?: string }) => err.code === 'not_an_owner',
    );
  });

  it('updateExcerpt rejects unknown position with excerpt_not_found', async () => {
    const kg = new InMemoryKnowledgeGraph();
    const owner = await seedAliceCluster(kg);
    const created = await kg.createMemorableKnowledge({
      kind: 'insight',
      summary: 'sparse',
      createdBy: `web:${owner}`,
      involvedOmadiaUserIds: [owner],
      aclOwners: [owner],
      palaiaExcerpts: { texts: ['x'], source: 'llm' },
    });
    await assert.rejects(
      kg.updateExcerpt(
        created.memorableKnowledgeNodeId,
        4,
        { text: 'nope' },
        { actorOmadiaUserId: owner },
      ),
      (err: { code?: string }) => err.code === 'excerpt_not_found',
    );
  });

  it('deleteMemory cascade-removes attached excerpts', async () => {
    const kg = new InMemoryKnowledgeGraph();
    const owner = await seedAliceCluster(kg);
    const created = await kg.createMemorableKnowledge({
      kind: 'insight',
      summary: 'will-be-gone',
      createdBy: `web:${owner}`,
      involvedOmadiaUserIds: [owner],
      aclOwners: [owner],
      palaiaExcerpts: { texts: ['a', 'b'], source: 'llm' },
    });
    await kg.deleteMemory(created.memorableKnowledgeNodeId, {
      actorOmadiaUserId: owner,
    });
    const after = await kg.listExcerptsForMemory(
      created.memorableKnowledgeNodeId,
    );
    assert.equal(after.length, 0);
  });
});
