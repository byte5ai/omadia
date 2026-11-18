import { strict as assert } from 'node:assert';
import { describe, it, before, after } from 'node:test';

import {
  NeonKnowledgeGraph,
  createNeonPool,
} from '@omadia/knowledge-graph-neon/dist/neonKnowledgeGraph.js';
import { runGraphMigrations } from '@omadia/knowledge-graph-neon/dist/migrator.js';
import type { Pool } from 'pg';

import { createMemberNameResolver } from '../src/services/memberNames.js';
import { probePgTest } from './_helpers/pgTestDb.js';

// ---------------------------------------------------------------------------
// Names for the owners of `members` notes, from the KG user clusters the
// identity layer keeps — the memory browser's labels.
//
// Skips (loudly) without a reachable pgvector Postgres — see issue #572.
// ---------------------------------------------------------------------------

const TENANT = `member-names-${Date.now()}`;

let pool: Pool | undefined;
let reachable = false;

describe('member names · Neon user clusters', () => {
  before(async () => {
    const probe = await probePgTest({
      label: 'memberNames',
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
    }
  });

  after(async () => {
    await pool?.end();
  });

  it('resolves a cluster to its identity name and email, scoped to the tenant', async (t) => {
    if (!reachable) return t.skip('no pgvector Postgres');
    const kg = new NeonKnowledgeGraph({ pool: pool!, tenantId: TENANT });
    const named = await kg.resolveOrCreateChannelIdentity({
      channelKind: 'teams',
      channelUserId: 'aad-marcel',
      aadObjectId: 'aad-marcel',
      displayName: 'Marcel Wege',
      email: 'marcel@example.com',
      emailVerified: true,
    });
    const bare = await kg.resolveOrCreateChannelIdentity({
      channelKind: 'telegram',
      channelUserId: 'telegram:4711',
    });
    const other = await new NeonKnowledgeGraph({ pool: pool!, tenantId: `${TENANT}-other` })
      .resolveOrCreateChannelIdentity({ channelKind: 'teams', channelUserId: 'aad-x', displayName: 'Fremd' });

    const names = await createMemberNameResolver(pool!, TENANT)([
      named.omadiaUserId,
      bare.omadiaUserId,
      other.omadiaUserId,
    ]);
    assert.equal(names.get(named.omadiaUserId)?.displayName, 'Marcel Wege');
    assert.equal(names.get(named.omadiaUserId)?.email, 'marcel@example.com');
    assert.equal(names.get(bare.omadiaUserId)?.displayName ?? null, null);
    assert.equal(names.has(other.omadiaUserId), false, 'a cluster of another tenant was named');
  });

  it('answers an empty lookup without a query', async (t) => {
    if (!reachable) return t.skip('no pgvector Postgres');
    assert.equal((await createMemberNameResolver(pool!, TENANT)([])).size, 0);
  });
});
