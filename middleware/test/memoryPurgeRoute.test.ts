import { strict as assert } from 'node:assert';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import express from 'express';
import { Pool } from 'pg';

import { resolvePgTestUrl } from './_helpers/pgTestDb.js';
import { InMemoryMemoryStore } from '@omadia/memory';
import { memoryContextKey } from '@omadia/channel-sdk';
import { InMemoryKnowledgeGraph } from '@omadia/knowledge-graph-inmemory';

import {
  createMemoryPurgeRouter,
  PREVIEW_TOKEN_TTL_MS,
  type MemoryPurgeDeps,
} from '../src/routes/memoryPurge.js';
import type { MemoryPurgeAuditStore } from '../src/services/memoryPurgeAudit.js';
import { runAuthMigrations } from '../src/auth/migrator.js';
import { seedConversationTurn, seedTeamsIdentity } from './_helpers/conversationFixture.js';
import { listenLoopback } from './_helpers/listenLoopback.js';

/**
 * HTTP integration test for the Danger-Zone memory-purge router
 * (`createMemoryPurgeRouter`, mounted in prod at
 * `/api/v1/admin/memory/purge`). Drives the REAL router end-to-end over an
 * express `listen(0)` server with a real `InMemoryMemoryStore` (scratch), a
 * real `InMemoryKnowledgeGraph` (MemorableKnowledge + conversation history)
 * and — when a throwaway Postgres is reachable — a real pg Pool for the
 * `memory_purge_audit` row.
 *
 * `requireAuth` is applied at MOUNT time in prod, not inside the router; the
 * harness stands in for it by putting a session on the request, because the
 * router records that session as the purge's actor (#1336).
 */

// No hardcoded default port (issue #572): the PG audit case runs only when an
// explicit test-Postgres URL is set, else it skips.
const PG_URL = resolvePgTestUrl('MEMORY_PG_TEST_URL', 'GRAPH_PG_TEST_URL');

const MOUNT = '/api/v1/admin/memory/purge';
const ADMIN_SESSION = {
  sub: 'admin@example.com',
  email: 'admin@example.com',
  /** `users.id` — what `admin_audit.actor_id` records (C07). */
  uid: '5d2e7a90-2222-4333-8444-a55566667777',
  /** KG cluster id — another namespace, never the audit actor. */
  omadia_user_id: '0b6f2c1e-1111-4222-8333-944455556666',
};

/** A real-shaped Teams team id (`:` + `@`) and the two spellings an operator
 *  may type for it. The route must confirm against the TYPED one. */
const TEAM_NATIVE_ID = '19:team-alpha@thread.tacv2';
const TEAM_SELECTOR = `teams~${TEAM_NATIVE_ID}`;
const TEAM_KEY = memoryContextKey('teams', TEAM_NATIVE_ID);

/** Two people, as omadia user ids — the spelling the KG `user_id` carries. */
const ALICE = '7f1b8a52-0000-4000-8000-00000000a11c';
const BOB = '7f1b8a52-0000-4000-8000-000000000b0b';

async function seedScratch(store: InMemoryMemoryStore): Promise<void> {
  await store.createFile('/memories/orchestrators/a/x.md', 'ax');
  await store.createFile('/memories/orchestrators/a/notes/deep.md', 'deep');
  await store.createFile('/memories/orchestrators/b/y.md', 'by');
  await store.createFile('/memories/_rules/r.md', 'rule');
  // Team ALPHA lives in BOTH agents — a context purge has to cross them.
  await store.createFile(`/memories/contexts/a/team/${TEAM_KEY}/n.md`, 'a-team');
  await store.createFile(`/memories/contexts/b/team/${TEAM_KEY}/n.md`, 'b-team');
  await store.createFile(`/memories/contexts/a/user/teams~u-1/n.md`, 'a-user');
  // User data that is never seed — no purge may take it (#1335).
  await store.createFile('/memories/chat-sessions/u1/tabs.json', '[]');
  await store.createFile('/memories/sessions/scope-1/log.md', 'q&a');
  await store.createFile('/memories/_brand/logo.md', 'logo');
  await store.createFile('/memories/core/kernel.md', 'core');
  await store.createFile('/memories/ui-prefs/u1.json', '{}');
}

async function seedKg(kg: InMemoryKnowledgeGraph): Promise<void> {
  await kg.createMemorableKnowledge({
    kind: 'insight',
    summary: 'A',
    originAgent: 'a',
    aclOwners: [ALICE],
    createdBy: 'test',
    involvedOmadiaUserIds: [],
  });
  await kg.createMemorableKnowledge({
    kind: 'insight',
    summary: 'B',
    originAgent: 'b',
    aclOwners: [BOB],
    createdBy: 'test',
    involvedOmadiaUserIds: [],
  });
  // Conversation history (#1334): agent a holds a group chat Alice and Bob
  // both spoke in, agent b one turn of Bob's.
  await seedConversationTurn(kg, { scope: 'a::teams::group', time: '2026-10-01T10:00:00Z', userId: ALICE, tag: 'a1' });
  await seedConversationTurn(kg, { scope: 'a::teams::group', time: '2026-10-01T10:01:00Z', userId: BOB, tag: 'a2' });
  await seedConversationTurn(kg, { scope: 'b::web::chat', time: '2026-10-01T11:00:00Z', userId: BOB, tag: 'b1' });
}

interface Harness {
  baseUrl: string;
  store: InMemoryMemoryStore;
  kg: InMemoryKnowledgeGraph;
  close: () => Promise<void>;
}

async function makeHarness(
  overrides: Partial<MemoryPurgeDeps> = {},
  session: Record<string, string> | null = ADMIN_SESSION,
): Promise<Harness> {
  const store = new InMemoryMemoryStore();
  await seedScratch(store);
  const kg = new InMemoryKnowledgeGraph();
  await seedKg(kg);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (session) (req as unknown as { session: unknown }).session = session;
    next();
  });
  app.use(MOUNT, createMemoryPurgeRouter({ store, knowledgeGraph: kg, ...overrides }));
  const server: Server = await listenLoopback(app);
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${String(port)}${MOUNT}`,
    store,
    kg,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

type Json = Record<string, unknown>;

async function call(
  url: string,
  method: 'POST' | 'DELETE',
  body: unknown,
): Promise<{ status: number; body: Json }> {
  const res = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: Json;
  try {
    parsed = text ? (JSON.parse(text) as Json) : {};
  } catch {
    parsed = { raw: text };
  }
  return { status: res.status, body: parsed };
}

interface Selection {
  axis: string;
  selector?: string;
  reseed?: boolean;
}

const preview = (h: Harness, sel: Selection) => call(`${h.baseUrl}/preview`, 'POST', sel);

/** The UI flow: preview, then delete with the preview's token. */
async function previewAndPurge(
  h: Harness,
  sel: Selection,
  confirm: string = sel.axis === 'all' ? 'DELETE ALL MEMORY' : (sel.selector ?? ''),
): Promise<{ preview: Json; status: number; body: Json }> {
  const p = await preview(h, sel);
  assert.equal(p.status, 200, JSON.stringify(p.body));
  const d = await call(h.baseUrl, 'DELETE', {
    ...sel,
    confirm,
    previewToken: p.body['previewToken'],
  });
  return { preview: p.body, ...d };
}

function codes(body: Json): string[] {
  return ((body['warnings'] as Array<{ code: string }> | undefined) ?? []).map((w) => w.code);
}

/** The preview promised exactly what the delete then removed (#1335). */
function assertPreviewMatches(previewBody: Json, deleteBody: Json): void {
  assert.equal(deleteBody['scratchDeleted'], previewBody['scratchCount'], 'scratch');
  assert.equal(deleteBody['kgDeleted'], previewBody['kgCount'], 'MemorableKnowledge');
  assert.equal(deleteBody['conversationDeleted'], previewBody['conversationCount'], 'conversation');
}

async function turnCount(kg: InMemoryKnowledgeGraph, scope: string): Promise<number> {
  const session = await kg.getSession(scope);
  return session?.turns.length ?? 0;
}

async function maybePgPool(): Promise<Pool | undefined> {
  if (!PG_URL) {
    console.error(
      '[memoryPurgeRoute] no MEMORY_PG_TEST_URL / GRAPH_PG_TEST_URL set — ' +
        'skipping the PG audit cases (issue #572).',
    );
    return undefined;
  }
  const pool = new Pool({ connectionString: PG_URL, max: 2 });
  try {
    await pool.query('SELECT 1');
    await pool.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
    // `admin_audit` lives in the auth series; the purge writes to it.
    await runAuthMigrations(pool);
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

  describe('agent axis', () => {
    it('preview counts the agent trees, its MemorableKnowledge and its conversation history', async () => {
      const h = await makeHarness();
      try {
        const res = await preview(h, { axis: 'agent', selector: 'a' });
        assert.equal(res.status, 200, JSON.stringify(res.body));
        // Targets, not files: `/memories/orchestrators/a` + `/memories/contexts/a`.
        assert.equal(res.body['scratchCount'], 2);
        assert.equal(res.body['kgCount'], 1);
        // Two turns of agent a, 8 nodes each, plus their shared Session.
        assert.equal(res.body['conversationCount'], 17);
        assert.equal(typeof res.body['previewToken'], 'string');
        assert.equal(await h.store.fileExists('/memories/orchestrators/a/x.md'), true);
      } finally {
        await h.close();
      }
    });

    it('delete removes exactly the previewed nodes — turns included — and leaves agent b alone (#1334)', async () => {
      const h = await makeHarness();
      try {
        const r = await previewAndPurge(h, { axis: 'agent', selector: 'a' });
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assertPreviewMatches(r.preview, r.body);

        assert.equal(await turnCount(h.kg, 'a::teams::group'), 0, "a's turns are gone");
        assert.equal(await turnCount(h.kg, 'b::web::chat'), 1, "b's turns survive");
        assert.equal((await h.kg.countConversationHistory({ tenantId: 'default' })).count, 9);
        assert.equal(await h.store.directoryExists('/memories/contexts/a'), false);
        assert.equal(await h.store.fileExists(`/memories/contexts/b/team/${TEAM_KEY}/n.md`), true);
        assert.equal(await h.store.fileExists('/memories/orchestrators/b/y.md'), true);
        assert.equal(await h.store.fileExists('/memories/_rules/r.md'), true);
        assert.equal((await h.kg.countMemorableKnowledge({ tenantId: 'default', originAgent: 'b' })).count, 1);
        assert.equal((await h.kg.countMemorableKnowledge({ tenantId: 'default', originAgent: 'a' })).count, 0);

        const again = await preview(h, { axis: 'all' });
        assert.equal(again.body['conversationCount'], 9, 'the remaining history is still counted');
      } finally {
        await h.close();
      }
    });
  });

  describe('user axis', () => {
    it("an omadia user id removes that user's turns, keeps the other speaker's in the same chat", async () => {
      const h = await makeHarness();
      try {
        const r = await previewAndPurge(h, { axis: 'user', selector: BOB });
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assertPreviewMatches(r.preview, r.body);
        // Bob's two turns (8 nodes each) + the b session he alone spoke in.
        assert.equal(r.body['conversationDeleted'], 17);
        assert.equal(r.body['kgDeleted'], 1);

        assert.equal(await turnCount(h.kg, 'a::teams::group'), 1, "Alice's turn and the group session stay");
        assert.equal(await turnCount(h.kg, 'b::web::chat'), 0);
      } finally {
        await h.close();
      }
    });

    it("a Teams user's turns go although they store the AAD id, not the omadia id", async () => {
      const h = await makeHarness();
      try {
        const aad = '3c9d6a10-aaaa-4bbb-8ccc-0000000ca401';
        const carol = await seedTeamsIdentity(h.kg, aad);
        await seedConversationTurn(h.kg, {
          scope: 'a::teams::dm-carol',
          time: '2026-10-02T09:00:00Z',
          userId: aad,
          runUserId: carol,
          tag: 'carol',
        });
        const r = await previewAndPurge(h, { axis: 'user', selector: carol });
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assertPreviewMatches(r.preview, r.body);
        assert.equal(r.body['conversationDeleted'], 9);
        assert.equal(await turnCount(h.kg, 'a::teams::dm-carol'), 0);
        assert.equal(await turnCount(h.kg, 'a::teams::group'), 2);
      } finally {
        await h.close();
      }
    });

    it('a context key purges the scratch tree and names the KG half that matched nothing', async () => {
      const h = await makeHarness();
      try {
        const r = await previewAndPurge(h, { axis: 'user', selector: 'teams~u-1' });
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assert.equal(r.body['scratchDeleted'], 1);
        assert.equal(r.body['kgDeleted'], 0);
        assert.equal(r.body['conversationDeleted'], 0);
        assert.deepEqual(codes(r.preview), ['user_axis_scratch_only', 'audit_unavailable']);
        assert.equal(await h.store.fileExists('/memories/contexts/a/user/teams~u-1/n.md'), false);
      } finally {
        await h.close();
      }
    });

    it('a selector without a channel type is refused with the explanation in `message`', async () => {
      const h = await makeHarness();
      try {
        for (const axis of ['team', 'channel', 'user'] as const) {
          const res = await preview(h, { axis, selector: 'Tom123' });
          assert.equal(res.status, 400, `${axis}: ${JSON.stringify(res.body)}`);
          assert.equal(res.body['error'], 'invalid_selector');
          assert.match(String(res.body['message']), /<channelType>~<id>/);
        }
      } finally {
        await h.close();
      }
    });
  });

  describe('team / channel axes', () => {
    it('warn with a translatable code that the KG is not modelled', async () => {
      const h = await makeHarness();
      try {
        const res = await preview(h, { axis: 'team', selector: TEAM_KEY });
        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.equal(res.body['scratchCount'], 2, 'one tree per agent');
        assert.equal(res.body['kgCount'], 0);
        assert.equal(res.body['conversationCount'], 0);
        assert.deepEqual(res.body['warnings'], [
          { code: 'kg_not_modelled', params: { axis: 'team' } },
          { code: 'audit_unavailable' },
        ]);
        assert.equal(res.body['warning'], undefined, 'no finished English sentence any more');
      } finally {
        await h.close();
      }
    });

    it('delete purges the context tree across agents and leaves the KG alone', async () => {
      const h = await makeHarness();
      try {
        const r = await previewAndPurge(h, { axis: 'team', selector: TEAM_SELECTOR });
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assertPreviewMatches(r.preview, r.body);
        assert.equal(r.body['scratchDeleted'], 2);
        assert.equal(await h.store.directoryExists(`/memories/contexts/a/team/${TEAM_KEY}`), false);
        assert.equal(await h.store.directoryExists(`/memories/contexts/b/team/${TEAM_KEY}`), false);
        assert.equal(await h.store.fileExists('/memories/contexts/a/user/teams~u-1/n.md'), true);
        assert.equal((await h.kg.countMemorableKnowledge({ tenantId: 'default' })).count, 2);
      } finally {
        await h.close();
      }
    });
  });

  describe('everything axis', () => {
    it('removes scratch, MemorableKnowledge and all conversation history; protected entries stay', async () => {
      const h = await makeHarness();
      try {
        const r = await previewAndPurge(h, { axis: 'all' });
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assertPreviewMatches(r.preview, r.body);
        assert.equal(r.body['conversationDeleted'], 26);
        assert.equal((await h.kg.countConversationHistory({ tenantId: 'default' })).count, 0);
        assert.equal(await h.store.fileExists('/memories/orchestrators/a/x.md'), false);
        assert.equal(await h.store.directoryExists('/memories/contexts'), false);
        for (const kept of ['_rules/r.md', 'chat-sessions/u1/tabs.json', 'sessions/scope-1/log.md', 'ui-prefs/u1.json']) {
          assert.equal(await h.store.fileExists(`/memories/${kept}`), true, kept);
        }
      } finally {
        await h.close();
      }
    });

    it('re-seed resets the bundled entries, writes them back, and keeps user data (#1335)', async () => {
      const seedDir = await mkdtemp(path.join(tmpdir(), 'purge-route-seed-'));
      await mkdir(path.join(seedDir, '_rules'));
      await writeFile(path.join(seedDir, '_rules', 'smart-cards.md'), 'bundled rule');
      const h = await makeHarness({ seedDir });
      try {
        const plain = await preview(h, { axis: 'all' });
        const withReseed = await preview(h, { axis: 'all', reseed: true });
        assert.equal(
          withReseed.body['scratchCount'],
          Number(plain.body['scratchCount']) + 1,
          'the preview counts the re-seeded entry',
        );
        assert.deepEqual(withReseed.body['reseedEntries'], ['_rules']);

        const r = await previewAndPurge(h, { axis: 'all', reseed: true });
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assertPreviewMatches(r.preview, r.body);
        assert.equal(r.body['reseededFiles'], 1);
        assert.equal(await h.store.fileExists('/memories/_rules/r.md'), false, 'runtime rule reset');
        assert.equal(await h.store.readFile('/memories/_rules/smart-cards.md'), 'bundled rule');
        for (const kept of [
          'chat-sessions/u1/tabs.json',
          'sessions/scope-1/log.md',
          '_brand/logo.md',
          'core/kernel.md',
          'ui-prefs/u1.json',
        ]) {
          assert.equal(await h.store.fileExists(`/memories/${kept}`), true, `${kept} survives a re-seed`);
        }
      } finally {
        await h.close();
        await rm(seedDir, { recursive: true, force: true });
      }
    });

    it('a preview without re-seed does not arm a re-seed delete', async () => {
      const h = await makeHarness({ seedDir: '/nonexistent' });
      try {
        const p = await preview(h, { axis: 'all' });
        const res = await call(h.baseUrl, 'DELETE', {
          axis: 'all',
          confirm: 'DELETE ALL MEMORY',
          reseed: true,
          previewToken: p.body['previewToken'],
        });
        assert.equal(res.status, 409, JSON.stringify(res.body));
        assert.equal(res.body['error'], 'preview_required');
      } finally {
        await h.close();
      }
    });
  });

  describe('safeguards (#1336)', () => {
    it('wrong confirmation → 400 confirmation_mismatch, nothing deleted', async () => {
      const h = await makeHarness();
      try {
        const r = await previewAndPurge(h, { axis: 'agent', selector: 'a' }, 'WRONG');
        assert.equal(r.status, 400);
        assert.equal(r.body['error'], 'confirmation_mismatch');
        assert.equal(await h.store.directoryExists('/memories/orchestrators/a'), true);
      } finally {
        await h.close();
      }
    });

    it('type-to-confirm guards the TYPED selector, not the derived ctxKey', async () => {
      const h = await makeHarness();
      try {
        const r = await previewAndPurge(h, { axis: 'team', selector: TEAM_SELECTOR }, TEAM_KEY);
        assert.equal(r.status, 400, JSON.stringify(r.body));
        assert.equal(r.body['error'], 'confirmation_mismatch');
        assert.equal(await h.store.directoryExists(`/memories/contexts/a/team/${TEAM_KEY}`), true);
      } finally {
        await h.close();
      }
    });

    it('a delete without a preview is refused', async () => {
      const h = await makeHarness();
      try {
        const res = await call(h.baseUrl, 'DELETE', { axis: 'agent', selector: 'a', confirm: 'a' });
        assert.equal(res.status, 409, JSON.stringify(res.body));
        assert.equal(res.body['error'], 'preview_required');
        assert.equal(await h.store.directoryExists('/memories/orchestrators/a'), true);
      } finally {
        await h.close();
      }
    });

    it("a preview token only arms its own selection, once, and expires", async () => {
      let now = 1_000_000;
      const h = await makeHarness({ now: () => now });
      try {
        const pa = await preview(h, { axis: 'agent', selector: 'a' });
        const wrong = await call(h.baseUrl, 'DELETE', {
          axis: 'agent',
          selector: 'b',
          confirm: 'b',
          previewToken: pa.body['previewToken'],
        });
        assert.equal(wrong.status, 409, 'token for agent a does not arm agent b');

        const ok = await call(h.baseUrl, 'DELETE', {
          axis: 'agent',
          selector: 'a',
          confirm: 'a',
          previewToken: pa.body['previewToken'],
        });
        assert.equal(ok.status, 200, JSON.stringify(ok.body));
        const reuse = await call(h.baseUrl, 'DELETE', {
          axis: 'agent',
          selector: 'a',
          confirm: 'a',
          previewToken: pa.body['previewToken'],
        });
        assert.equal(reuse.status, 409, 'single use');

        const pb = await preview(h, { axis: 'agent', selector: 'b' });
        now += PREVIEW_TOKEN_TTL_MS + 1;
        const late = await call(h.baseUrl, 'DELETE', {
          axis: 'agent',
          selector: 'b',
          confirm: 'b',
          previewToken: pb.body['previewToken'],
        });
        assert.equal(late.status, 409, 'expired');
        assert.equal(await h.store.directoryExists('/memories/orchestrators/b'), true);
      } finally {
        await h.close();
      }
    });

    it('without a session actor the purge is refused', async () => {
      const h = await makeHarness({}, null);
      try {
        const r = await previewAndPurge(h, { axis: 'agent', selector: 'a' });
        assert.equal(r.status, 401, JSON.stringify(r.body));
        assert.equal(await h.store.directoryExists('/memories/orchestrators/a'), true);
      } finally {
        await h.close();
      }
    });

    it('a failed audit write refuses the purge before anything is deleted', async () => {
      const auditStore: MemoryPurgeAuditStore = {
        recordStart: () => Promise.reject(new Error('db down')),
        recordOutcome: () => Promise.resolve(),
      };
      const h = await makeHarness({ auditStore });
      try {
        const r = await previewAndPurge(h, { axis: 'agent', selector: 'a' });
        assert.equal(r.status, 500, JSON.stringify(r.body));
        assert.equal(r.body['error'], 'audit_write_failed');
        assert.equal(await h.store.directoryExists('/memories/orchestrators/a'), true);
        assert.equal(await turnCount(h.kg, 'a::teams::group'), 2);
      } finally {
        await h.close();
      }
    });

    it('records the session actor and the outcome; a failed outcome write is reported', async () => {
      const starts: unknown[] = [];
      const outcomes: unknown[] = [];
      let failOutcome = false;
      const auditStore: MemoryPurgeAuditStore = {
        recordStart: (entry) => {
          starts.push(entry);
          return Promise.resolve('audit-1');
        },
        recordOutcome: (id, outcome) => {
          if (failOutcome) return Promise.reject(new Error('db down'));
          outcomes.push({ id, outcome });
          return Promise.resolve();
        },
      };
      const h = await makeHarness({ auditStore });
      try {
        const r = await previewAndPurge(h, { axis: 'agent', selector: 'a' });
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assert.equal(r.body['auditId'], 'audit-1');
        assert.deepEqual(codes(r.body), []);
        assert.deepEqual(starts, [
          {
            actor: { id: ADMIN_SESSION.uid, email: ADMIN_SESSION.email },
            axis: 'agent',
            selector: 'a',
            reseed: false,
            planned: { scratch: 2, kg: 1, conversation: 17, reseedEntries: [] },
          },
        ]);
        assert.deepEqual(outcomes, [
          { id: 'audit-1', outcome: { status: 'completed', deleted: { scratch: 2, kg: 1, conversation: 17 } } },
        ]);

        failOutcome = true;
        const r2 = await previewAndPurge(h, { axis: 'agent', selector: 'b' });
        assert.equal(r2.status, 200, JSON.stringify(r2.body));
        assert.deepEqual(r2.body['warnings'], [
          { code: 'audit_update_failed', params: { auditId: 'audit-1' } },
        ]);
      } finally {
        await h.close();
      }
    });

    it('a KG provider without the history primitives is reported, not counted as empty', async () => {
      const h = await makeHarness();
      try {
        // A third-party provider that predates plugin-api 1.30.0.
        const kg = h.kg as unknown as Record<string, unknown>;
        kg['countConversationHistory'] = undefined;
        kg['purgeConversationHistory'] = undefined;
        const res = await preview(h, { axis: 'agent', selector: 'a' });
        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.equal(res.body['conversationCount'], 0);
        assert.deepEqual(codes(res.body), ['kg_history_unsupported', 'audit_unavailable']);
      } finally {
        await h.close();
      }
    });

    it('a purge that fails part-way records what is already gone', async () => {
      const outcomes: unknown[] = [];
      const auditStore: MemoryPurgeAuditStore = {
        recordStart: () => Promise.resolve('audit-2'),
        recordOutcome: (_id, outcome) => {
          outcomes.push(outcome);
          return Promise.resolve();
        },
      };
      const h = await makeHarness({ auditStore });
      try {
        (h.kg as unknown as Record<string, unknown>)['purgeConversationHistory'] = () =>
          Promise.reject(Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }));
        const r = await previewAndPurge(h, { axis: 'agent', selector: 'a' });
        assert.equal(r.status, 500, JSON.stringify(r.body));
        assert.equal(r.body['error'], 'memory_purge_failed', 'a driver code is not surfaced');
        assert.deepEqual(outcomes, [
          {
            status: 'failed',
            deleted: { scratch: 2, kg: 1, conversation: 0 },
            error: 'connection reset',
          },
        ]);
      } finally {
        await h.close();
      }
    });

    it('without an audit store the response says the purge was not recorded', async () => {
      const h = await makeHarness();
      try {
        const r = await previewAndPurge(h, { axis: 'agent', selector: 'a' });
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assert.deepEqual(codes(r.body), ['audit_unavailable']);
        assert.equal(r.body['auditId'], undefined);
      } finally {
        await h.close();
      }
    });

    it('PG: the audit row names the signed-in user and the counts', async (t) => {
      if (!pgPool) {
        t.skip('throwaway Postgres not reachable — audit case skipped');
        return;
      }
      const pool = pgPool;
      const h = await makeHarness({ graphPool: pool });
      try {
        const r = await previewAndPurge(h, { axis: 'agent', selector: 'a' });
        assert.equal(r.status, 200, JSON.stringify(r.body));
        const row = await pool.query<Record<string, unknown>>(
          `SELECT actor, actor_id, actor_email, axis, selector, status,
                  scratch_deleted, kg_deleted, conversation_deleted, completed_at
             FROM memory_purge_audit WHERE id = $1`,
          [r.body['auditId']],
        );
        const audit = row.rows[0]!;
        assert.equal(audit['actor'], ADMIN_SESSION.email);
        assert.equal(audit['actor_id'], ADMIN_SESSION.uid);
        assert.equal(audit['actor_email'], ADMIN_SESSION.email);
        assert.equal(audit['axis'], 'agent');
        assert.equal(audit['selector'], 'a');
        assert.equal(audit['status'], 'completed');
        assert.equal(audit['scratch_deleted'], 2);
        assert.equal(audit['kg_deleted'], 1);
        assert.equal(audit['conversation_deleted'], 17);
        assert.ok(audit['completed_at'] instanceof Date);

        // The same purge sits in the admin trail (/admin/audit) next to the
        // other admin actions.
        const ledger = await pool.query<Record<string, unknown>>(
          `SELECT actor_id, actor_email, after FROM admin_audit
            WHERE action = 'memory.purge' AND target = $1`,
          [`memory-purge:${String(r.body['auditId'])}`],
        );
        assert.equal(ledger.rowCount, 1);
        assert.equal(ledger.rows[0]!['actor_id'], ADMIN_SESSION.uid);
        assert.equal(ledger.rows[0]!['actor_email'], ADMIN_SESSION.email);
        assert.deepEqual((ledger.rows[0]!['after'] as Record<string, unknown>)['planned'], {
          scratch: 2,
          kg: 1,
          conversation: 17,
          reseedEntries: [],
        });
      } finally {
        await h.close();
      }
    });
  });
});
