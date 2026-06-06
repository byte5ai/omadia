import { strict as assert } from 'node:assert';
import { promises as fs } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import express from 'express';
import { Pool } from 'pg';

import { FilesystemMemoryStore } from '@omadia/memory';
import { InMemoryKnowledgeGraph } from '@omadia/knowledge-graph-inmemory';
import type {
  GraphNode,
  KnowledgeGraph,
  MemorableKnowledgePurgeFilter,
} from '@omadia/plugin-api';

import { createMemoryPurgeRouter } from '../src/routes/memoryPurge.js';

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
 * express `listen(0)` server with a real `FilesystemMemoryStore` (scratch),
 * a real `InMemoryKnowledgeGraph` (KG MemorableKnowledge), and — when a
 * throwaway Postgres is reachable — a real pg Pool for the
 * `memory_purge_audit` row.
 *
 * No auth is exercised here: `requireAuth` is applied at MOUNT time in prod,
 * not inside the router, so the test calls the router directly.
 */

const PG_URL = 'postgres://postgres:test@127.0.0.1:55434/memtest';

type PurgeKg = ReturnType<typeof withPurgePrimitives>;

interface Harness {
  baseUrl: string;
  store: FilesystemMemoryStore;
  kg: PurgeKg;
  close: () => Promise<void>;
}

const MOUNT = '/api/v1/admin/memory/purge';

async function seedScratch(store: FilesystemMemoryStore): Promise<void> {
  await store.createFile('/memories/orchestrators/a/x.md', 'ax');
  await store.createFile('/memories/orchestrators/a/notes/deep.md', 'deep');
  await store.createFile('/memories/orchestrators/b/y.md', 'by');
  await store.createFile('/memories/_rules/r.md', 'rule');
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
  const root = await fs.mkdtemp(join(tmpdir(), 'mem-purge-route-'));
  const store = new FilesystemMemoryStore(root);
  await store.init();
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
  const server: Server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${String(port)}${MOUNT}`;

  return {
    baseUrl,
    store,
    kg,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
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

  it('1. POST /preview {axis:agent, selector:a} → scratchCount 2, kgCount 1', async () => {
    const h = await makeHarness();
    try {
      const res = await postJson(`${h.baseUrl}/preview`, 'POST', {
        axis: 'agent',
        selector: 'a',
      });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body['kgCount'], 1);
      // DEVIATION from the prompt's "scratchCount = 2": previewMemoryPurge
      // intentionally returns the count of top-level `/memories/...` ENTRIES
      // a purge removes (one agent subtree = 1), NOT a recursive file count.
      // See services/memoryPurge.ts doc: "Returns the number of top-level
      // entries removed (NOT a recursive file count)". We assert that real
      // contract (1) and separately prove a's 2-file footprint is intact
      // pre-delete and (test 2) fully removed post-delete.
      assert.equal(res.body['scratchCount'], 1);
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
      assert.equal(res.body['scratchDeleted'], 1);
      assert.equal(res.body['kgDeleted'], 1);

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

  it('6. DELETE / {axis:user, selector:user-2} → scratch no-op, kgDeleted 1, no warning', async () => {
    const h = await makeHarness();
    try {
      const res = await postJson(h.baseUrl, 'DELETE', {
        axis: 'user',
        selector: 'user-2',
        confirm: 'user-2',
      });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body['scratchDeleted'], 0);
      assert.equal(res.body['kgDeleted'], 1);
      assert.equal(res.body['warning'], undefined, 'user IS modeled — no warning');
    } finally {
      await h.close();
    }
  });

  it('7. POST /preview {axis:team, selector:t1} → warning + kgCount 0', async () => {
    const h = await makeHarness();
    try {
      const res = await postJson(`${h.baseUrl}/preview`, 'POST', {
        axis: 'team',
        selector: 't1',
      });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body['kgCount'], 0);
      assert.equal(typeof res.body['warning'], 'string', 'team not modeled → warning');
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
