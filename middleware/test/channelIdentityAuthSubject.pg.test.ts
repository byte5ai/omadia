import { strict as assert } from 'node:assert';
import { describe, it, before, after } from 'node:test';

import {
  NeonKnowledgeGraph,
  createNeonPool,
} from '@omadia/knowledge-graph-neon/dist/neonKnowledgeGraph.js';
import { runGraphMigrations } from '@omadia/knowledge-graph-neon/dist/migrator.js';
import type { Pool } from 'pg';

import { probePgTest } from './_helpers/pgTestDb.js';

// ---------------------------------------------------------------------------
// Issue #568 — the Neon half of the channel-turn → per_user-MCP-token bridge.
//
// WHY THIS SUITE EXISTS SEPARATELY FROM `slice1bUserCluster.test.ts`
// -----------------------------------------------------------------
// That file covers the same contract against `InMemoryKnowledgeGraph`, plus a
// TEXT-level assertion that the Neon SQL filters by tenant. Neither executes
// the Neon implementation, and Neon is the production path. The three things
// most likely to be wrong here are all SQL-shaped and invisible to both:
//
//   - the `properties || $3::jsonb` backfill on the fast path (a `jsonb_set`
//     of a missing key, or the operands the wrong way round, silently no-ops
//     or clobbers),
//   - the `ORDER BY … lastSeenAt DESC` sibling lookup crossing the
//     IS_IDENTITY_OF edge in the right direction,
//   - reading the subject INSIDE the caller's transaction, so it reflects the
//     backfill this same call just wrote.
//
// Skips (loudly) without a reachable pgvector Postgres — see issue #572.
// ---------------------------------------------------------------------------

const TENANT = 'issue568-tenant';

let pool: Pool | undefined;
let reachable = false;

let seq = 0;
/** Unique per test, so one suite run cannot merge clusters across cases. */
const nextId = (): string => `${Date.now()}-${++seq}`;

describe('#568 · Neon cluster auth subject', () => {
  before(async () => {
    const probe = await probePgTest({
      label: 'channelIdentityAuthSubject',
      // CI sets GRAPH_PG_TEST_URL and MEMORY_PG_TEST_URL (see ci.yml), so this
      // suite RUNS there rather than skipping into a permanently-green no-op.
      // WS3_PG_URL stays first for local runs that already export it.
      vars: ['WS3_PG_URL', 'GRAPH_PG_TEST_URL', 'MEMORY_PG_TEST_URL'],
      requireVector: true,
    });
    if (!probe.reachable) return;
    pool = createNeonPool(probe.url!, 2);
    try {
      await runGraphMigrations(pool);
      reachable = true;
    } catch {
      reachable = false;
      await pool.end().catch(() => undefined);
      pool = undefined;
    }
  });

  after(async () => {
    if (pool) {
      await pool
        .query(`DELETE FROM graph_nodes WHERE tenant_id = $1`, [TENANT])
        .catch(() => undefined);
      await pool.end().catch(() => undefined);
    }
  });

  const graph = (): NeonKnowledgeGraph =>
    new NeonKnowledgeGraph({ pool: pool!, tenantId: TENANT });

  it('returns the subject an authenticating login established', async (t) => {
    if (!reachable) return t.skip('no pg');
    const kg = graph();
    const res = await kg.resolveOrCreateChannelIdentity({
      channelKind: 'web',
      channelUserId: `users-${nextId()}`,
      email: `ada-${nextId()}@example.com`,
      emailVerified: true,
      authSubject: { provider: 'entra', providerUserId: 'aad-oid-neon-1' },
    });
    assert.deepEqual(res.clusterAuthSubject, {
      provider: 'entra',
      providerUserId: 'aad-oid-neon-1',
    });
  });

  it('a Teams identity merging into that cluster inherits the SUBJECT', async (t) => {
    if (!reachable) return t.skip('no pg');
    const kg = graph();
    const email = `bob-${nextId()}@example.com`;
    const oid = `aad-oid-neon-${nextId()}`;

    const web = await kg.resolveOrCreateChannelIdentity({
      channelKind: 'web',
      channelUserId: `users-${nextId()}`,
      email,
      emailVerified: true,
      authSubject: { provider: 'entra', providerUserId: oid },
    });
    // Same human over Teams; merges on the verified email.
    const teams = await kg.resolveOrCreateChannelIdentity({
      channelKind: 'teams',
      channelUserId: `teams-${nextId()}`,
      email,
      emailVerified: true,
    });

    assert.equal(teams.omadiaUserId, web.omadiaUserId, 'the merge itself did not happen');
    assert.deepEqual(
      teams.clusterAuthSubject,
      { provider: 'entra', providerUserId: oid },
      'the Teams turn cannot see the subject its operator authorized under — #568 is back',
    );
  });

  it('a cluster with no authenticated identity reports NO subject', async (t) => {
    if (!reachable) return t.skip('no pg');
    const res = await graph().resolveOrCreateChannelIdentity({
      channelKind: 'telegram',
      channelUserId: `tg-${nextId()}`,
    });
    assert.equal(
      res.clusterAuthSubject,
      undefined,
      'a channel-only user must not appear to own an IdP subject',
    );
  });

  it('backfills on the FAST path (the jsonb merge), stranding no pre-existing identity', async (t) => {
    if (!reachable) return t.skip('no pg');
    const kg = graph();
    const channelUserId = `users-${nextId()}`;

    const before = await kg.resolveOrCreateChannelIdentity({
      channelKind: 'web',
      channelUserId,
    });
    assert.equal(before.clusterAuthSubject, undefined);

    const after = await kg.resolveOrCreateChannelIdentity({
      channelKind: 'web',
      channelUserId,
      authSubject: { provider: 'local', providerUserId: 'ada@example.com' },
    });
    assert.equal(after.isNewIdentity, false, 'expected the fast path, not a fresh identity');
    assert.deepEqual(
      after.clusterAuthSubject,
      { provider: 'local', providerUserId: 'ada@example.com' },
      'the fast-path jsonb merge did not land — the subject is read back in the SAME transaction',
    );
  });

  it('a channel-side re-resolve does NOT erase a subject a login established', async (t) => {
    if (!reachable) return t.skip('no pg');
    const kg = graph();
    const channelUserId = `users-${nextId()}`;
    await kg.resolveOrCreateChannelIdentity({
      channelKind: 'web',
      channelUserId,
      authSubject: { provider: 'entra', providerUserId: 'aad-oid-keepme' },
    });
    // Carries no authSubject — must merge, not replace.
    const again = await kg.resolveOrCreateChannelIdentity({
      channelKind: 'web',
      channelUserId,
    });
    assert.deepEqual(again.clusterAuthSubject, {
      provider: 'entra',
      providerUserId: 'aad-oid-keepme',
    });
  });

  it('tenant-strict: another tenant’s subject is never returned', async (t) => {
    if (!reachable) return t.skip('no pg');
    const channelUserId = `users-${nextId()}`;
    const other = new NeonKnowledgeGraph({ pool: pool!, tenantId: `${TENANT}-other` });
    try {
      await other.resolveOrCreateChannelIdentity({
        channelKind: 'web',
        channelUserId,
        email: 'shared@example.com',
        emailVerified: true,
        authSubject: { provider: 'entra', providerUserId: 'aad-oid-OTHER-TENANT' },
      });
      const mine = await graph().resolveOrCreateChannelIdentity({
        channelKind: 'teams',
        channelUserId: `teams-${nextId()}`,
        email: 'shared@example.com',
        emailVerified: true,
      });
      assert.equal(
        mine.clusterAuthSubject,
        undefined,
        'a cross-tenant subject leaked — that key would authorize as someone else entirely',
      );
    } finally {
      await pool!
        .query(`DELETE FROM graph_nodes WHERE tenant_id = $1`, [`${TENANT}-other`])
        .catch(() => undefined);
    }
  });
});
