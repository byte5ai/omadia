import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, it } from 'node:test';

import { InMemoryKnowledgeGraph } from '@omadia/knowledge-graph-inmemory';
import {
  GRAPH_EDGE_TYPES,
  GRAPH_NODE_TYPES,
  validateNodeProps,
} from '@omadia/knowledge-graph-neon';
import {
  channelIdentityNodeId,
  userNodeId,
} from '@omadia/plugin-api';

/**
 * Slice 1b — User-Cluster + ChannelIdentity introduction.
 *
 * Three test surfaces:
 *   1. Migration 0015 SQL is shaped correctly — TRUNCATEs the 7 KG-package
 *      tables, declares the partial verified-email index, single
 *      transaction.
 *   2. The Neon schema enums + Zod validators expose the new types and
 *      reject the old User shape.
 *   3. InMemory `resolveOrCreateChannelIdentity` implements the hybrid
 *      cluster-merge contract: idempotent re-call, verified-email merge
 *      across channels, no merge without verified email.
 *
 * Live-DB integration (migration runs end-to-end on the dev Neon DSN,
 * cross-tenant boundaries hold) is covered by
 * `scripts/smoke/slice-1b-cluster.ts`, not in the unit suite.
 */

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATION_PATH = join(
  here,
  '..',
  'packages',
  'harness-knowledge-graph-neon',
  'src',
  'migrations',
  '0015_user_cluster.sql',
);

const NEW_NODE_TYPES = ['ChannelIdentity'] as const;
const NEW_EDGE_TYPES = ['IS_IDENTITY_OF'] as const;
const WIPED_TABLES = [
  'graph_edges',
  'graph_nodes',
  'processes',
  'process_history',
  'nudge_state',
  'nudge_emissions',
  'agent_priorities',
] as const;

describe('Slice 1b · migration 0015 SQL file', () => {
  it('runs in a single transaction', async () => {
    const sql = await readFile(MIGRATION_PATH, 'utf8');
    assert.match(sql, /^BEGIN;/m);
    assert.match(sql, /^COMMIT;/m);
  });

  it('TRUNCATEs all 7 KG-package tables with CASCADE', async () => {
    const sql = await readFile(MIGRATION_PATH, 'utf8');
    assert.match(sql, /TRUNCATE TABLE/);
    assert.match(sql, /CASCADE;/);
    for (const t of WIPED_TABLES) {
      assert.match(sql, new RegExp(`\\b${t}\\b`), `wipe must include ${t}`);
    }
  });

  it('creates partial index for verified-email cluster-merge', async () => {
    const sql = await readFile(MIGRATION_PATH, 'utf8');
    assert.match(
      sql,
      /CREATE INDEX IF NOT EXISTS idx_channel_identity_verified_email/,
    );
    assert.match(sql, /WHERE type = 'ChannelIdentity'/);
    assert.match(sql, /\(properties->>'emailVerified'\)::boolean = true/);
  });
});

describe('Slice 1b · schema enum additions', () => {
  for (const added of NEW_NODE_TYPES) {
    it(`GRAPH_NODE_TYPES now contains '${added}'`, () => {
      assert.equal(
        (GRAPH_NODE_TYPES as readonly string[]).includes(added),
        true,
      );
    });
  }

  for (const added of NEW_EDGE_TYPES) {
    it(`GRAPH_EDGE_TYPES now contains '${added}'`, () => {
      assert.equal(
        (GRAPH_EDGE_TYPES as readonly string[]).includes(added),
        true,
      );
    });
  }
});

describe('Slice 1b · UserPropsSchema (post-refactor)', () => {
  const validOmadiaUserId = 'b3a6f1c2-7b8a-4d4f-9c1d-1e2f3a4b5c6d';
  const now = new Date().toISOString();

  it('accepts the new cluster-root shape', () => {
    const parsed = validateNodeProps('User', {
      omadiaUserId: validOmadiaUserId,
      firstSeenAt: now,
      lastSeenAt: now,
      displayName: 'Test User',
    });
    assert.equal(parsed['omadiaUserId'], validOmadiaUserId);
  });

  it('rejects the old channel-bound userId shape', () => {
    assert.throws(() =>
      validateNodeProps('User', {
        userId: 'aad-oid-xyz',
        firstSeenAt: now,
        lastSeenAt: now,
      } as Record<string, unknown>),
    );
  });

  it('rejects non-uuid omadiaUserId', () => {
    assert.throws(() =>
      validateNodeProps('User', {
        omadiaUserId: 'not-a-uuid',
        firstSeenAt: now,
        lastSeenAt: now,
      }),
    );
  });
});

describe('Slice 1b · ChannelIdentityPropsSchema', () => {
  const now = new Date().toISOString();

  it('accepts a Teams identity with verified email', () => {
    const parsed = validateNodeProps('ChannelIdentity', {
      channelKind: 'teams',
      channelUserId: 'aad-oid-abc',
      displayName: 'Alice',
      email: 'alice@example.com',
      emailVerified: true,
      firstSeenAt: now,
      lastSeenAt: now,
    });
    assert.equal(parsed['channelKind'], 'teams');
  });

  it('accepts a Telegram identity without email', () => {
    const parsed = validateNodeProps('ChannelIdentity', {
      channelKind: 'telegram',
      channelUserId: '5551234567',
      firstSeenAt: now,
      lastSeenAt: now,
    });
    assert.equal(parsed['channelKind'], 'telegram');
  });

  it('rejects unknown channelKind', () => {
    assert.throws(() =>
      validateNodeProps('ChannelIdentity', {
        channelKind: 'discord',
        channelUserId: 'x',
        firstSeenAt: now,
        lastSeenAt: now,
      }),
    );
  });

  it('rejects malformed email', () => {
    assert.throws(() =>
      validateNodeProps('ChannelIdentity', {
        channelKind: 'teams',
        channelUserId: 'x',
        email: 'not-an-email',
        firstSeenAt: now,
        lastSeenAt: now,
      }),
    );
  });
});

describe('Slice 1b · InMemory resolveOrCreateChannelIdentity', () => {
  let kg: InMemoryKnowledgeGraph;

  beforeEach(() => {
    kg = new InMemoryKnowledgeGraph();
  });

  it('first call creates a new 1:1 cluster + identity', async () => {
    const r = await kg.resolveOrCreateChannelIdentity({
      channelKind: 'telegram',
      channelUserId: '5551234567',
      displayName: 'Bob',
    });
    assert.equal(r.isNewIdentity, true);
    assert.equal(r.isNewCluster, true);
    assert.equal(
      r.channelIdentityNodeId,
      channelIdentityNodeId('telegram', '5551234567'),
    );
    assert.equal(r.userNodeId, userNodeId(r.omadiaUserId));
  });

  it('is idempotent: re-call with same identity returns same cluster', async () => {
    const first = await kg.resolveOrCreateChannelIdentity({
      channelKind: 'teams',
      channelUserId: 'aad-oid-abc',
      email: 'alice@example.com',
      emailVerified: true,
    });
    const second = await kg.resolveOrCreateChannelIdentity({
      channelKind: 'teams',
      channelUserId: 'aad-oid-abc',
      email: 'alice@example.com',
      emailVerified: true,
    });
    assert.equal(second.omadiaUserId, first.omadiaUserId);
    assert.equal(second.userNodeId, first.userNodeId);
    assert.equal(second.isNewIdentity, false);
    assert.equal(second.isNewCluster, false);
  });

  it('hybrid-merges across channels on verified-email match', async () => {
    const teams = await kg.resolveOrCreateChannelIdentity({
      channelKind: 'teams',
      channelUserId: 'aad-oid-abc',
      email: 'alice@example.com',
      emailVerified: true,
    });
    const slack = await kg.resolveOrCreateChannelIdentity({
      channelKind: 'slack',
      channelUserId: 'U12345',
      email: 'alice@example.com',
      emailVerified: true,
    });
    assert.equal(slack.omadiaUserId, teams.omadiaUserId);
    assert.equal(slack.isNewIdentity, true);
    assert.equal(slack.isNewCluster, false);
  });

  it('does NOT merge when email is unverified on either side', async () => {
    const teams = await kg.resolveOrCreateChannelIdentity({
      channelKind: 'teams',
      channelUserId: 'aad-oid-abc',
      email: 'alice@example.com',
      emailVerified: false,
    });
    const slack = await kg.resolveOrCreateChannelIdentity({
      channelKind: 'slack',
      channelUserId: 'U12345',
      email: 'alice@example.com',
      emailVerified: true,
    });
    assert.notEqual(slack.omadiaUserId, teams.omadiaUserId);
    assert.equal(slack.isNewCluster, true);
  });

  it('does NOT merge when one side has no email', async () => {
    const telegram = await kg.resolveOrCreateChannelIdentity({
      channelKind: 'telegram',
      channelUserId: '5551234567',
    });
    const teams = await kg.resolveOrCreateChannelIdentity({
      channelKind: 'teams',
      channelUserId: 'aad-oid-abc',
      email: 'alice@example.com',
      emailVerified: true,
    });
    assert.notEqual(teams.omadiaUserId, telegram.omadiaUserId);
    assert.equal(teams.isNewCluster, true);
  });

  it('merges across channels via AAD oid (no email required)', async () => {
    const web = await kg.resolveOrCreateChannelIdentity({
      channelKind: 'web',
      channelUserId: 'users-row-uuid-abc',
      aadObjectId: 'aad-oid-xyz',
      emailVerified: true,
    });
    const teams = await kg.resolveOrCreateChannelIdentity({
      channelKind: 'teams',
      channelUserId: 'aad-oid-xyz',
      aadObjectId: 'aad-oid-xyz',
      // intentionally no email — proves oid-merge runs before email-merge.
    });
    assert.equal(teams.omadiaUserId, web.omadiaUserId);
    assert.equal(teams.isNewIdentity, true);
    assert.equal(teams.isNewCluster, false);
  });

  it('AAD oid match wins over email-only match for the same incoming call', async () => {
    // Seed two clusters: one with email-only, one with aad-oid only.
    const emailCluster = await kg.resolveOrCreateChannelIdentity({
      channelKind: 'web',
      channelUserId: 'users-row-uuid-A',
      email: 'shared@example.com',
      emailVerified: true,
    });
    const oidCluster = await kg.resolveOrCreateChannelIdentity({
      channelKind: 'teams',
      channelUserId: 'aad-oid-target',
      aadObjectId: 'aad-oid-target',
    });
    assert.notEqual(oidCluster.omadiaUserId, emailCluster.omadiaUserId);

    // Incoming with BOTH the verified email AND the matching oid: oid
    // wins (matches first in resolver order).
    const incoming = await kg.resolveOrCreateChannelIdentity({
      channelKind: 'slack',
      channelUserId: 'U-slack-shared',
      email: 'shared@example.com',
      emailVerified: true,
      aadObjectId: 'aad-oid-target',
    });
    assert.equal(incoming.omadiaUserId, oidCluster.omadiaUserId);
  });

  it('treats email case-insensitively when merging', async () => {
    const teams = await kg.resolveOrCreateChannelIdentity({
      channelKind: 'teams',
      channelUserId: 'aad-oid-abc',
      email: 'Alice@Example.COM',
      emailVerified: true,
    });
    const slack = await kg.resolveOrCreateChannelIdentity({
      channelKind: 'slack',
      channelUserId: 'U12345',
      email: 'alice@example.com',
      emailVerified: true,
    });
    assert.equal(slack.omadiaUserId, teams.omadiaUserId);
  });

  it('ingestRun rejects unresolved userId', async () => {
    await kg.ingestTurn({
      scope: 's1',
      time: new Date().toISOString(),
      userMessage: 'hi',
      assistantAnswer: 'hello',
      entityRefs: [],
    });
    await assert.rejects(
      kg.ingestRun({
        turnId: `turn:s1:${new Date().toISOString()}`,
        scope: 's1',
        userId: 'never-resolved',
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        durationMs: 1,
        status: 'success',
        iterations: 1,
        orchestratorToolCalls: [],
        agentInvocations: [],
      }),
      /User-Cluster.*not found/,
    );
  });
});

describe('Slice 1b · Neon SQL guards tenant boundary', () => {
  it('resolveOrCreateChannelIdentity SQL filters by tenant_id', async () => {
    const neonImplPath = join(
      here,
      '..',
      'packages',
      'harness-knowledge-graph-neon',
      'src',
      'neonKnowledgeGraph.ts',
    );
    const code = await readFile(neonImplPath, 'utf8');
    // Anchor on the method declaration (not the comment / error-msg
    // mentions earlier in the file), then read to the next public method.
    const methodStart = code.indexOf('async resolveOrCreateChannelIdentity(');
    assert.ok(methodStart > 0, 'method declaration not found');
    const tail = code.slice(methodStart);
    const methodEnd = tail.indexOf('async findEntities(');
    assert.ok(methodEnd > 0, 'findEntities marker not found');
    const methodBody = tail.slice(0, methodEnd);
    const tenantHits = methodBody.match(/tenant_id\s*=\s*\$1/g) ?? [];
    assert.ok(
      tenantHits.length >= 2,
      `expected at least 2 tenant_id=$1 filters in resolveOrCreateChannelIdentity, saw ${tenantHits.length}`,
    );
  });
});
