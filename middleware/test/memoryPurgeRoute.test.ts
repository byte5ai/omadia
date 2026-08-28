import { strict as assert } from 'node:assert';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';

import express from 'express';
import { Pool } from 'pg';

import { resolvePgTestUrl } from './_helpers/pgTestDb.js';
import { InMemoryMemoryStore } from '@omadia/memory';
import { memoryContextKey } from '@omadia/channel-sdk';
import { InMemoryKnowledgeGraph } from '@omadia/knowledge-graph-inmemory';
import type {
  GraphNode,
  KnowledgeGraph,
  MemorableKnowledgePurgeFilter,
} from '@omadia/plugin-api';

import { createMemoryPurgeRouter } from '../src/routes/memoryPurge.js';
import { listenLoopback } from './_helpers/listenLoopback.js';

/**
 * The router calls `knowledgeGraph.countMemorableKnowledge(filter)` and
 * `knowledgeGraph.purgeMemorableKnowledge(filter)`. Those purge/count
 * PRIMITIVES are only implemented by the Postgres (Neon) backend; the
 * in-memory backend has every OTHER MemorableKnowledge method but not these
 * two. Rather than hand-fake counts, this thin adapter implements them over
 * the REAL nodes the in-memory KG created (enumerated via
 * `listMemorableKnowledgeWithEmbeddings`, deleted via `deleteMemory`),
 * matching on the same `origin_agent` / `acl_owners` node props the Neon
 * backend filters on. The router therefore drives genuine KG data end-to-end.
 */
type PurgeMethods = {
  countMemorableKnowledge: (
    f: MemorableKnowledgePurgeFilter,
  ) => Promise<{ count: number }>;
  purgeMemorableKnowledge: (
    f: MemorableKnowledgePurgeFilter,
  ) => Promise<{ deletedNodes: number }>;
};

function withPurgePrimitives(
  kg: InMemoryKnowledgeGraph,
): InMemoryKnowledgeGraph & KnowledgeGraph & PurgeMethods {
  function matches(node: GraphNode, f: MemorableKnowledgePurgeFilter): boolean {
    if (f.originAgent !== undefined) {
      if (node.props['origin_agent'] !== f.originAgent) return false;
    }
    if (f.aclOwner !== undefined) {
      const owners = Array.isArray(node.props['acl_owners'])
        ? (node.props['acl_owners'] as unknown[])
        : [];
      if (!owners.includes(f.aclOwner)) return false;
    }
    return true;
  }

  async function selected(
    f: MemorableKnowledgePurgeFilter,
  ): Promise<GraphNode[]> {
    const all = await kg.listMemorableKnowledgeWithEmbeddings();
    return all.map((e) => e.mk).filter((mk) => matches(mk, f));
  }

  const adapter = kg as unknown as KnowledgeGraph & Record<string, unknown>;
  adapter['countMemorableKnowledge'] = async (
    f: MemorableKnowledgePurgeFilter,
  ) => ({ count: (await selected(f)).length });
  adapter['purgeMemorableKnowledge'] = async (
    f: MemorableKnowledgePurgeFilter,
  ) => {
    const victims = await selected(f);
    for (const mk of victims) {
      // The Neon `purgeMemorableKnowledge` admin primitive deletes WITHOUT an
      // ACL check; the in-memory backend only exposes the ACL-gated
      // `deleteMemory`, so act AS one of the node's own owners to satisfy the
      // gate (equivalent end state: the MK and its edges are dropped).
      const owners = Array.isArray(mk.props['acl_owners'])
        ? (mk.props['acl_owners'] as string[])
        : [];
      await kg.deleteMemory(mk.id, {
        actorOmadiaUserId: owners[0] ?? 'system',
      });
    }
    return { deletedNodes: victims.length };
  };
  return adapter as unknown as InMemoryKnowledgeGraph &
    KnowledgeGraph &
    PurgeMethods;
}

/**
 * HTTP integration test for the Danger-Zone memory-purge router
 * (`createMemoryPurgeRouter`, mounted in prod at
 * `/api/v1/admin/memory/purge`). Drives the REAL router end-to-end over an
 * express `listen(0)` server with a real `InMemoryMemoryStore` (scratch),
 * a real `InMemoryKnowledgeGraph` (KG MemorableKnowledge), and — when a
 * throwaway Postgres is reachable — a real pg Pool for the
 * `memory_purge_audit` row. The scratch store is an in-memory
 * `InMemoryMemoryStore` (same MemoryStore contract).
 *
 * No auth is exercised here: `requireAuth` is applied at MOUNT time in prod,
 * not inside the router, so the test calls the router directly.
 */

// No hardcoded default port (issue #572): the PG audit case runs only when an
// explicit test-Postgres URL is set, else it skips.
const PG_URL = resolvePgTestUrl('MEMORY_PG_TEST_URL', 'GRAPH_PG_TEST_URL');

type PurgeKg = ReturnType<typeof withPurgePrimitives>;

interface Harness {
  baseUrl: string;
  store: InMemoryMemoryStore;
  kg: PurgeKg;
  close: () => Promise<void>;
}

const MOUNT = '/api/v1/admin/memory/purge';

/** A real-shaped Teams team id (`:` + `@`) and the two spellings an operator
 *  may type for it. The route must confirm against the TYPED one. */
const TEAM_NATIVE_ID = '19:team-alpha@thread.tacv2';
const TEAM_SELECTOR = `teams~${TEAM_NATIVE_ID}`;
const TEAM_KEY = memoryContextKey('teams', TEAM_NATIVE_ID);

async function seedScratch(store: InMemoryMemoryStore): Promise<void> {
  await store.createFile('/memories/orchestrators/a/x.md', 'ax');
  await store.createFile('/memories/orchestrators/a/notes/deep.md', 'deep');
  await store.createFile('/memories/orchestrators/b/y.md', 'by');
  await store.createFile('/memories/_rules/r.md', 'rule');
  // Team ALPHA lives in BOTH agents — a context purge has to cross them.
  await store.createFile(`/memories/contexts/a/team/${TEAM_KEY}/n.md`, 'a-team');
  await store.createFile(`/memories/contexts/b/team/${TEAM_KEY}/n.md`, 'b-team');
  await store.createFile(`/memories/contexts/a/user/teams~u-1/n.md`, 'a-user');
}

async function seedKg(kg: InMemoryKnowledgeGraph): Promise<void> {
  // The in-memory backend only enumerates MK nodes that carry an embedding
  // (see listMemorableKnowledgeWithEmbeddings). Seed a trivial vector per MK
  // via the test-only setEmbedding hook so the purge adapter can see them.
  const a = await kg.createMemorableKnowledge({
    kind: 'insight',
    summary: 'A',
    originAgent: 'a',
    aclOwners: ['user-1'],
    createdBy: 'test',
    involvedOmadiaUserIds: [],
  });
  kg.setEmbedding(a.memorableKnowledgeNodeId, [1, 0]);
  const b = await kg.createMemorableKnowledge({
    kind: 'insight',
    summary: 'B',
    originAgent: 'b',
    aclOwners: ['user-2'],
    createdBy: 'test',
    involvedOmadiaUserIds: [],
  });
  kg.setEmbedding(b.memorableKnowledgeNodeId, [0, 1]);
}

/** Stand up a fresh server + freshly-seeded scratch store + KG. Optionally
 *  wire a pg Pool as `graphPool` so the audit row is written. */
async function makeHarness(graphPool?: Pool): Promise<Harness> {
  const store = new InMemoryMemoryStore();
  await seedScratch(store);

  const kg = withPurgePrimitives(new InMemoryKnowledgeGraph());
  await seedKg(kg);

  const app = express();
  app.use(express.json());
  app.use(
    MOUNT,
    createMemoryPurgeRouter({
      store,
      knowledgeGraph: kg,
      ...(graphPool ? { graphPool } : {}),
    }),
  );
  const server: Server = await listenLoopback(app);
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${String(port)}${MOUNT}`;

  return {
    baseUrl,
    store,
    kg,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function postJson(
  url: string,
  method: 'POST' | 'DELETE',
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: Record<string, unknown>;
  try {
    parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    parsed = { raw: text };
  }
  return { status: res.status, body: parsed };
}

/** Probe whether the throwaway Postgres is reachable; if so return a Pool with
 *  pgcrypto ensured (router needs gen_random_uuid). Else undefined → audit
 *  case skipped. */
async function maybePgPool(): Promise<Pool | undefined> {
  if (!PG_URL) {
    console.error(
      '[memoryPurgeRoute] no MEMORY_PG_TEST_URL / GRAPH_PG_TEST_URL set — ' +
        'skipping the PG audit case (issue #572).',
    );
    return undefined;
  }
  const pool = new Pool({ connectionString: PG_URL, max: 2 });
  try {
    await pool.query('SELECT 1');
    await pool.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
    return pool;
  } catch {
    await pool.end().catch(() => undefined);
    return undefined;
  }
}

describe('memory-purge router (HTTP, end-to-end)', () => {
  let pgPool: Pool | undefined;

  before(async () => {
    pgPool = await maybePgPool();
  });

  after(async () => {
    if (pgPool) await pgPool.end().catch(() => undefined);
  });

  it('1. POST /preview {axis:agent, selector:a} → scratchCount 2 (agent tree + context forest), kgCount 1', async () => {
    const h = await makeHarness();
    try {
      const res = await postJson(`${h.baseUrl}/preview`, 'POST', {
        axis: 'agent',
        selector: 'a',
      });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body['kgCount'], 1);
      // previewMemoryPurge counts TARGETS, not files: agent 'a' owns two
      // subtrees — `/memories/orchestrators/a` and its context forest
      // `/memories/contexts/a` — so the honest preview is 2. (Before the
      // chat-context ACL this was 1; the second target is the new context
      // forest, not a recursive file count.) We separately prove a's file
      // footprint is intact pre-delete and (test 2) fully removed post-delete.
      assert.equal(res.body['scratchCount'], 2);
      assert.equal(
        await h.store.fileExists('/memories/orchestrators/a/x.md'),
        true,
      );
      assert.equal(
        await h.store.fileExists('/memories/orchestrators/a/notes/deep.md'),
        true,
      );
    } finally {
      await h.close();
    }
  });

  it('2. DELETE / {axis:agent, selector:a, confirm:a} → deletes a, leaves b + rules', async () => {
    const h = await makeHarness(pgPool);
    try {
      const res = await postJson(h.baseUrl, 'DELETE', {
        axis: 'agent',
        selector: 'a',
        confirm: 'a',
      });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body['scratchDeleted'], 2);
      assert.equal(res.body['kgDeleted'], 1);

      assert.equal(
        await h.store.directoryExists('/memories/contexts/a'),
        false,
        "a's context forest goes with the agent",
      );
      assert.equal(
        await h.store.fileExists(`/memories/contexts/b/team/${TEAM_KEY}/n.md`),
        true,
        "b's half of the shared team survives an agent purge",
      );
      assert.equal(
        await h.store.fileExists('/memories/orchestrators/b/y.md'),
        true,
        'b survives',
      );
      assert.equal(
        await h.store.fileExists('/memories/_rules/r.md'),
        true,
        'rules survive',
      );
      assert.equal(
        await h.store.directoryExists('/memories/orchestrators/a'),
        false,
        'a subtree gone',
      );

      const bCount = await h.kg.countMemorableKnowledge({
        tenantId: 'default',
        originAgent: 'b',
      });
      assert.equal(bCount.count, 1, 'b MK survives');
      const aCount = await h.kg.countMemorableKnowledge({
        tenantId: 'default',
        originAgent: 'a',
      });
      assert.equal(aCount.count, 0, 'a MK gone');
    } finally {
      await h.close();
    }
  });

  it('3. DELETE / with wrong confirm → 400 confirmation_mismatch', async () => {
    const h = await makeHarness();
    try {
      const res = await postJson(h.baseUrl, 'DELETE', {
        axis: 'agent',
        selector: 'a',
        confirm: 'WRONG',
      });
      assert.equal(res.status, 400, JSON.stringify(res.body));
      assert.equal(res.body['error'], 'confirmation_mismatch');
      // Nothing deleted.
      assert.equal(
        await h.store.directoryExists('/memories/orchestrators/a'),
        true,
      );
    } finally {
      await h.close();
    }
  });

  it('4. DELETE / {axis:all} (no reseed) → orchestrators gone, _rules protected', async () => {
    const h = await makeHarness();
    try {
      const res = await postJson(h.baseUrl, 'DELETE', {
        axis: 'all',
        confirm: 'DELETE ALL MEMORY',
      });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(
        await h.store.fileExists('/memories/_rules/r.md'),
        true,
        '_rules protected from axis:all without reseed',
      );
      assert.equal(
        await h.store.fileExists('/memories/orchestrators/a/x.md'),
        false,
        'orchestrators purged',
      );
      assert.equal(
        await h.store.directoryExists('/memories/contexts'),
        false,
        'contexts is ordinary scratch — axis:all takes it without naming it',
      );
    } finally {
      await h.close();
    }
  });

  it('5. DELETE / {axis:all, reseed:true} → _rules gone too', async () => {
    const h = await makeHarness();
    try {
      const res = await postJson(h.baseUrl, 'DELETE', {
        axis: 'all',
        confirm: 'DELETE ALL MEMORY',
        reseed: true,
      });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(
        await h.store.fileExists('/memories/_rules/r.md'),
        false,
        '_rules removed with reseed',
      );
    } finally {
      await h.close();
    }
  });

  it('6. DELETE / {axis:user, selector:user-2} → 400 invalid_selector, nothing deleted', async () => {
    // `user-2` is a KG acl-owner id, not a context key: it has no
    // `<channelType>~` half, so it can never name a context tree. This used to
    // answer 200 / {scratchDeleted: 0} with a warning claiming the scratch
    // trees WERE affected — a Danger-Zone gesture reporting success for a
    // delete that could not possibly have matched. It is now refused loudly,
    // and the KG leg does not run either: a selector this route cannot resolve
    // must not half-execute.
    const h = await makeHarness();
    try {
      const res = await postJson(h.baseUrl, 'DELETE', {
        axis: 'user',
        selector: 'user-2',
        confirm: 'user-2',
      });
      assert.equal(res.status, 400, JSON.stringify(res.body));
      assert.equal(res.body['error'], 'invalid_selector');
      assert.match(String(res.body['message']), /<channelType>~<id>/);
      assert.equal(
        await h.store.fileExists('/memories/contexts/a/user/teams~u-1/n.md'),
        true,
        'nothing was deleted',
      );
      assert.equal((await h.kg.countMemorableKnowledge({ tenantId: 'default' })).count, 2);
    } finally {
      await h.close();
    }
  });

  it("6b. DELETE / {axis:user, selector:teams~u-1} → the scratch tree goes, and the KG/scratch seam is named", async () => {
    // The two legs of the user axis consume the selector in INCOMPATIBLE
    // spellings: the KG matches it raw as an `aclOwner`, the purge service as a
    // `<channelType>~<id>` context key. At most one can ever match, and the
    // operator has to be told which half was a no-op instead of reading a 200
    // as "the user was purged".
    const h = await makeHarness();
    try {
      const res = await postJson(h.baseUrl, 'DELETE', {
        axis: 'user',
        selector: 'teams~u-1',
        confirm: 'teams~u-1',
      });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body['scratchDeleted'], 1);
      assert.equal(res.body['kgDeleted'], 0);
      assert.match(
        String(res.body['warning']),
        /Knowledge-Graph rows .* NOT purged/,
        'the no-op half must be named',
      );
      assert.equal(
        await h.store.fileExists('/memories/contexts/a/user/teams~u-1/n.md'),
        false,
      );
    } finally {
      await h.close();
    }
  });

  it('7. POST /preview {axis:team} → warning names the KG as the untouched half', async () => {
    const h = await makeHarness();
    try {
      const res = await postJson(`${h.baseUrl}/preview`, 'POST', {
        axis: 'team',
        selector: TEAM_KEY,
      });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body['kgCount'], 0);
      // Team ALPHA lives in both agents, so the honest preview is 2 trees.
      assert.equal(res.body['scratchCount'], 2);
      const warning = res.body['warning'];
      assert.equal(typeof warning, 'string', 'team not modeled → warning');
      // The warning used to claim "only scratch memory is affected", which read
      // backwards once the context trees existed. It must now say the KG is the
      // untouched half — and must not imply an invented KG filter.
      assert.match(String(warning), /Knowledge-Graph is left untouched/);
      assert.doesNotMatch(String(warning), /only scratch memory is affected/);
      assert.match(String(warning), /scratch trees are affected/);
    } finally {
      await h.close();
    }
  });

  it('7b. POST /preview {axis:team} that matches nothing does NOT claim an effect', async () => {
    // The same defect class the warning above was written to fix: promising an
    // effect that did not happen. A well-formed selector that resolves to zero
    // trees is the likeliest operator mistake on this surface, and it must not
    // be reported as "the scratch trees were affected".
    const h = await makeHarness();
    try {
      const res = await postJson(`${h.baseUrl}/preview`, 'POST', {
        axis: 'team',
        selector: 'teams~does-not-exist',
      });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body['scratchCount'], 0);
      const warning = String(res.body['warning']);
      assert.match(warning, /No matching context tree exists/);
      assert.doesNotMatch(warning, /scratch trees are affected/);
    } finally {
      await h.close();
    }
  });

  it('7c. a context selector with no channel-type half is refused, not silently ignored', async () => {
    const h = await makeHarness();
    try {
      for (const axis of ['team', 'channel', 'user'] as const) {
        const res = await postJson(`${h.baseUrl}/preview`, 'POST', {
          axis,
          selector: '19:team-alpha@thread.tacv2',
        });
        assert.equal(res.status, 400, `${axis}: ${JSON.stringify(res.body)}`);
        assert.equal(res.body['error'], 'invalid_selector');
      }
    } finally {
      await h.close();
    }
  });

  it('9. DELETE / {axis:team} purges the context tree across agents, KG untouched', async () => {
    const h = await makeHarness();
    try {
      const preview = await postJson(`${h.baseUrl}/preview`, 'POST', {
        axis: 'team',
        selector: TEAM_SELECTOR,
      });
      assert.equal(preview.status, 200, JSON.stringify(preview.body));
      assert.equal(preview.body['scratchCount'], 2, 'one target per agent');

      const res = await postJson(h.baseUrl, 'DELETE', {
        axis: 'team',
        selector: TEAM_SELECTOR,
        confirm: TEAM_SELECTOR,
      });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body['scratchDeleted'], 2);
      assert.equal(res.body['kgDeleted'], 0, 'no KG filter is fabricated');
      assert.match(String(res.body['warning']), /Knowledge-Graph was left untouched/);

      assert.equal(
        await h.store.directoryExists(`/memories/contexts/a/team/${TEAM_KEY}`),
        false,
      );
      assert.equal(
        await h.store.directoryExists(`/memories/contexts/b/team/${TEAM_KEY}`),
        false,
      );
      // Agent trees and the other context axis survive.
      assert.equal(await h.store.fileExists('/memories/orchestrators/a/x.md'), true);
      assert.equal(
        await h.store.fileExists('/memories/contexts/a/user/teams~u-1/n.md'),
        true,
      );
      // The KG kept both MKs — the team axis has no KG column.
      const all = await h.kg.countMemorableKnowledge({ tenantId: 'default' });
      assert.equal(all.count, 2);
    } finally {
      await h.close();
    }
  });

  it('10. type-to-confirm guards the TYPED selector, not the derived ctxKey', async () => {
    const h = await makeHarness();
    try {
      // Confirming with the normalised key while having typed the raw selector
      // must be rejected: the gesture guards the input, not the normalisation.
      const mismatch = await postJson(h.baseUrl, 'DELETE', {
        axis: 'team',
        selector: TEAM_SELECTOR,
        confirm: TEAM_KEY,
      });
      assert.equal(mismatch.status, 400, JSON.stringify(mismatch.body));
      assert.equal(mismatch.body['error'], 'confirmation_mismatch');
      assert.equal(
        await h.store.directoryExists(`/memories/contexts/a/team/${TEAM_KEY}`),
        true,
        'nothing deleted on a mismatch',
      );

      // Re-typing the selector verbatim is what unlocks it.
      const ok = await postJson(h.baseUrl, 'DELETE', {
        axis: 'team',
        selector: TEAM_SELECTOR,
        confirm: TEAM_SELECTOR,
      });
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      assert.equal(ok.body['scratchDeleted'], 2);
    } finally {
      await h.close();
    }
  });

  it('8. audit row written when graphPool present (PG)', async (t) => {
    if (!pgPool) {
      t.skip('throwaway Postgres not reachable — audit case skipped');
      return;
    }
    const pool = pgPool;
    // The router lazily CREATEs the audit table on first delete; before that
    // it may not exist, so a missing-relation pre-count reads as 0.
    const beforeCount = await pool
      .query<{ count: number }>(
        'SELECT count(*)::int AS count FROM memory_purge_audit',
      )
      .then((r) => r.rows[0]!.count)
      .catch(() => 0);
    const h = await makeHarness(pool);
    try {
      const res = await postJson(h.baseUrl, 'DELETE', {
        axis: 'agent',
        selector: 'a',
        confirm: 'a',
      });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const after = await pool.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM memory_purge_audit',
      );
      assert.ok(
        after.rows[0]!.count >= 1,
        'at least one audit row exists after a delete',
      );
      assert.ok(
        after.rows[0]!.count > beforeCount,
        'a new audit row was written by this delete',
      );
    } finally {
      await h.close();
    }
  });
});
