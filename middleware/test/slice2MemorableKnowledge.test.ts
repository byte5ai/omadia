import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, it } from 'node:test';

import { InMemoryKnowledgeGraph } from '@omadia/knowledge-graph-inmemory';
import {
  GRAPH_EDGE_TYPES,
  GRAPH_NODE_TYPES,
  MEMORABLE_KINDS,
  validateNodeProps,
} from '@omadia/knowledge-graph-neon';
import { memorableKnowledgeNodeId } from '@omadia/plugin-api';

/**
 * Slice 2 — MemorableKnowledge surfaces:
 *   1. Migration 0017 SQL declares the two partial indexes.
 *   2. Schema enums + Zod props validate the new type.
 *   3. InMemory KG `createMemorableKnowledge` / `getMemorableKnowledge` /
 *      `listMemorableKnowledgeFor` round-trip a node + INVOLVED / REQUIRES
 *      / DERIVED_FROM edges, skip missing endpoints, filter by `kind`.
 *
 * Slice-3 ACL behaviour (acl_owners filter) is NOT exercised here — the
 * field is present and validates as `string[]` but the resolve-logic
 * lives in slice 3.
 */

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATION_PATH = join(
  here,
  '..',
  'packages',
  'harness-knowledge-graph-neon',
  'src',
  'migrations',
  '0017_memorable_knowledge.sql',
);

describe('Slice 2 · migration 0017 SQL file', () => {
  it('runs in a single transaction', async () => {
    const sql = await readFile(MIGRATION_PATH, 'utf8');
    assert.match(sql, /^BEGIN;/m);
    assert.match(sql, /^COMMIT;/m);
  });

  it('declares idx_memorable_kind partial index', async () => {
    const sql = await readFile(MIGRATION_PATH, 'utf8');
    assert.match(sql, /CREATE INDEX IF NOT EXISTS idx_memorable_kind/);
    assert.match(sql, /WHERE type = 'MemorableKnowledge'/);
  });

  it('declares idx_memorable_significance partial index', async () => {
    const sql = await readFile(MIGRATION_PATH, 'utf8');
    assert.match(sql, /CREATE INDEX IF NOT EXISTS idx_memorable_significance/);
    assert.match(sql, /properties->>'significance' IS NOT NULL/);
  });
});

describe('Slice 2 · schema enums', () => {
  it("GRAPH_NODE_TYPES now contains 'MemorableKnowledge'", () => {
    assert.equal(
      (GRAPH_NODE_TYPES as readonly string[]).includes('MemorableKnowledge'),
      true,
    );
  });

  for (const edge of ['INVOLVED', 'REQUIRES'] as const) {
    it(`GRAPH_EDGE_TYPES now contains '${edge}'`, () => {
      assert.equal(
        (GRAPH_EDGE_TYPES as readonly string[]).includes(edge),
        true,
      );
    });
  }

  it('MEMORABLE_KINDS exposes the four taxonomy values', () => {
    assert.deepEqual(MEMORABLE_KINDS, [
      'decision',
      'insight',
      'preference',
      'reference',
    ]);
  });
});

describe('Slice 2 · MemorableKnowledgePropsSchema', () => {
  const now = new Date().toISOString();
  const base = {
    kind: 'decision',
    summary: 'Decided to use Postgres for prod.',
    rationale: 'Neon already on-shelf; pgvector ready.',
    significance: 0.82,
    acl_owners: [] as string[],
    created_at: now,
    created_by: 'web:00000000-0000-0000-0000-000000000001',
  };

  it('accepts the canonical shape', () => {
    const parsed = validateNodeProps('MemorableKnowledge', base);
    assert.equal(parsed['kind'], 'decision');
    assert.equal(parsed['summary'], base.summary);
    assert.deepEqual(parsed['acl_owners'], []);
  });

  it('defaults acl_owners to []', () => {
    const minimal = {
      kind: 'preference',
      summary: 'Always reply in German first.',
      created_at: now,
      created_by: 'web:abc',
    };
    const parsed = validateNodeProps('MemorableKnowledge', minimal);
    assert.deepEqual(parsed['acl_owners'], []);
  });

  it('rejects unknown kind', () => {
    assert.throws(() =>
      validateNodeProps('MemorableKnowledge', { ...base, kind: 'random' }),
    );
  });

  it('rejects out-of-range significance', () => {
    assert.throws(() =>
      validateNodeProps('MemorableKnowledge', { ...base, significance: 1.7 }),
    );
  });

  it('rejects missing summary', () => {
    const { summary: _summary, ...rest } = base;
    assert.throws(() => validateNodeProps('MemorableKnowledge', rest));
  });
});

describe('Slice 2 · InMemory createMemorableKnowledge round-trip', () => {
  let kg: InMemoryKnowledgeGraph;
  const userA = '11111111-2222-3333-4444-555555555555';
  const userB = '99999999-8888-7777-6666-aaaaaaaaaaaa';
  const channelByA = 'web:user-a-row-uuid';

  beforeEach(async () => {
    kg = new InMemoryKnowledgeGraph();
    // Seed two user clusters so INVOLVED edges have endpoints.
    await kg.resolveOrCreateChannelIdentity({
      channelKind: 'web',
      channelUserId: 'user-a-row-uuid',
      aadObjectId: userA, // doubles as a quick way to anchor a fixed cluster id below
    });
    await kg.resolveOrCreateChannelIdentity({
      channelKind: 'web',
      channelUserId: 'user-b-row-uuid',
      aadObjectId: userB,
    });
  });

  it('creates an MK node + INVOLVED edges; returns the mk: external id', async () => {
    // Look up the resolver-assigned omadiaUserIds for the two seed clusters.
    const all = await kg.stats();
    assert.equal(all.byNodeType['User'], 2);

    // Re-resolve to grab the cluster pointers (idempotent).
    const a = await kg.resolveOrCreateChannelIdentity({
      channelKind: 'web',
      channelUserId: 'user-a-row-uuid',
      aadObjectId: userA,
    });
    const b = await kg.resolveOrCreateChannelIdentity({
      channelKind: 'web',
      channelUserId: 'user-b-row-uuid',
      aadObjectId: userB,
    });

    const result = await kg.createMemorableKnowledge({
      kind: 'decision',
      summary: 'Wir gehen mit Postgres.',
      rationale: 'Neon on shelf.',
      significance: 0.9,
      createdBy: channelByA,
      involvedOmadiaUserIds: [a.omadiaUserId, b.omadiaUserId],
    });
    assert.ok(result.memorableKnowledgeNodeId.startsWith('mk:'));
    assert.equal(result.skippedInvolved, 0);

    const node = await kg.getMemorableKnowledge(result.memorableKnowledgeNodeId);
    assert.ok(node);
    assert.equal(node?.type, 'MemorableKnowledge');
    assert.equal(node?.props['kind'], 'decision');
    assert.equal(node?.props['created_by'], channelByA);
  });

  it('skips INVOLVED entries for missing user-clusters and counts them', async () => {
    const a = await kg.resolveOrCreateChannelIdentity({
      channelKind: 'web',
      channelUserId: 'user-a-row-uuid',
      aadObjectId: userA,
    });
    const result = await kg.createMemorableKnowledge({
      kind: 'insight',
      summary: 'Telegram users keep losing context after restart.',
      createdBy: channelByA,
      involvedOmadiaUserIds: [a.omadiaUserId, 'ghost-uuid-no-cluster'],
    });
    assert.equal(result.skippedInvolved, 1);
  });

  it('listMemorableKnowledgeFor returns only MKs where the user is INVOLVED', async () => {
    const a = await kg.resolveOrCreateChannelIdentity({
      channelKind: 'web',
      channelUserId: 'user-a-row-uuid',
      aadObjectId: userA,
    });
    const b = await kg.resolveOrCreateChannelIdentity({
      channelKind: 'web',
      channelUserId: 'user-b-row-uuid',
      aadObjectId: userB,
    });

    await kg.createMemorableKnowledge({
      kind: 'preference',
      summary: 'Only A involved',
      createdBy: channelByA,
      involvedOmadiaUserIds: [a.omadiaUserId],
    });
    await kg.createMemorableKnowledge({
      kind: 'decision',
      summary: 'Both A and B involved',
      createdBy: channelByA,
      involvedOmadiaUserIds: [a.omadiaUserId, b.omadiaUserId],
    });
    await kg.createMemorableKnowledge({
      kind: 'reference',
      summary: 'Only B involved',
      createdBy: channelByA,
      involvedOmadiaUserIds: [b.omadiaUserId],
    });

    const forA = await kg.listMemorableKnowledgeFor(a.omadiaUserId);
    assert.equal(forA.length, 2);
    const forB = await kg.listMemorableKnowledgeFor(b.omadiaUserId);
    assert.equal(forB.length, 2);
  });

  it('listMemorableKnowledgeFor honours the kind filter', async () => {
    const a = await kg.resolveOrCreateChannelIdentity({
      channelKind: 'web',
      channelUserId: 'user-a-row-uuid',
      aadObjectId: userA,
    });
    await kg.createMemorableKnowledge({
      kind: 'decision',
      summary: 'D1',
      createdBy: channelByA,
      involvedOmadiaUserIds: [a.omadiaUserId],
    });
    await kg.createMemorableKnowledge({
      kind: 'preference',
      summary: 'P1',
      createdBy: channelByA,
      involvedOmadiaUserIds: [a.omadiaUserId],
    });

    const decisions = await kg.listMemorableKnowledgeFor(a.omadiaUserId, {
      kind: 'decision',
    });
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0]?.props['kind'], 'decision');
  });

  it('listMemorableKnowledgeFor returns [] for an unknown omadiaUserId', async () => {
    const out = await kg.listMemorableKnowledgeFor('no-such-user-uuid');
    assert.deepEqual(out, []);
  });

  it('memorableKnowledgeNodeId helper prefixes with `mk:`', () => {
    assert.equal(memorableKnowledgeNodeId('abc'), 'mk:abc');
  });

  it('REQUIRES + DERIVED_FROM skip missing or wrong-type endpoints', async () => {
    // Seed an OdooEntity so one REQUIRES has a valid endpoint.
    await kg.ingestEntities([
      {
        system: 'odoo',
        model: 'res.partner',
        id: 42,
        displayName: 'Acme GmbH',
      },
    ]);
    const a = await kg.resolveOrCreateChannelIdentity({
      channelKind: 'web',
      channelUserId: 'user-a-row-uuid',
      aadObjectId: userA,
    });

    const result = await kg.createMemorableKnowledge({
      kind: 'reference',
      summary: 'Acme contact lives at billing@acme.io',
      createdBy: channelByA,
      involvedOmadiaUserIds: [a.omadiaUserId],
      requiredEntityIds: [
        'odoo:res.partner:42', // valid OdooEntity
        'odoo:res.partner:999', // missing
        a.userNodeId, // wrong type (User, not Entity)
      ],
      derivedFromTurnIds: ['turn:no-such:1970-01-01T00:00:00.000Z'],
    });
    assert.equal(result.skippedRequired, 2);
    assert.equal(result.skippedDerivedFrom, 1);
  });
});
