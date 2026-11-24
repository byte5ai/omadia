import { strict as assert } from 'node:assert';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import express from 'express';

import { InMemoryMemoryStore } from '@omadia/memory';
import { memoryContextKey } from '@omadia/channel-sdk';
import { InMemoryKnowledgeGraph } from '@omadia/knowledge-graph-inmemory';

import { createMemoryPurgeRouter, type MemoryPurgeDeps } from '../../src/routes/memoryPurge.js';
import { seedConversationTurn, seedTeamsIdentity } from './conversationFixture.js';
import { listenLoopback } from './listenLoopback.js';

/**
 * Harness for the Danger-Zone memory-purge router (`createMemoryPurgeRouter`,
 * mounted in prod at `/api/v1/admin/memory/purge`), shared by
 * `memoryPurgeRoute.test.ts` (in-memory) and `memoryPurgeRoute.pg.test.ts`
 * (the `memory_purge_audit` row on real Postgres).
 *
 * `requireAuth` is applied at MOUNT time in prod, not inside the router; the
 * harness stands in for it by putting a session on the request, because the
 * router records that session as the purge's actor (#1336).
 */

export const MOUNT = '/api/v1/admin/memory/purge';
export const ADMIN_SESSION = {
  sub: 'admin@example.com',
  email: 'admin@example.com',
  /** `users.id` — what `admin_audit.actor_id` records (C07). */
  uid: '5d2e7a90-2222-4333-8444-a55566667777',
  /** KG cluster id — another namespace, never the audit actor. */
  omadia_user_id: '0b6f2c1e-1111-4222-8333-944455556666',
};

/** A real-shaped Teams team id (`:` + `@`) and the two spellings an operator
 *  may type for it. The route must confirm against the TYPED one. */
export const TEAM_NATIVE_ID = '19:team-alpha@thread.tacv2';
export const TEAM_SELECTOR = `teams~${TEAM_NATIVE_ID}`;
export const TEAM_KEY = memoryContextKey('teams', TEAM_NATIVE_ID);

/** Two people, as omadia user ids — the spelling the KG `user_id` carries. */
export const ALICE = '7f1b8a52-0000-4000-8000-00000000a11c';
export const BOB = '7f1b8a52-0000-4000-8000-000000000b0b';

export async function seedScratch(store: InMemoryMemoryStore): Promise<void> {
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

export async function seedKg(kg: InMemoryKnowledgeGraph): Promise<void> {
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

export interface Harness {
  baseUrl: string;
  store: InMemoryMemoryStore;
  kg: InMemoryKnowledgeGraph;
  close: () => Promise<void>;
}

export async function makeHarness(
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

export type Json = Record<string, unknown>;

export async function call(
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

export interface Selection {
  axis: string;
  selector?: string;
  reseed?: boolean;
}

export const preview = (h: Harness, sel: Selection) => call(`${h.baseUrl}/preview`, 'POST', sel);

/** The UI flow: preview, then delete with the preview's token. */
export async function previewAndPurge(
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

export function codes(body: Json): string[] {
  return ((body['warnings'] as Array<{ code: string }> | undefined) ?? []).map((w) => w.code);
}

/** The preview promised exactly what the delete then removed (#1335). */
export function assertPreviewMatches(previewBody: Json, deleteBody: Json): void {
  assert.equal(deleteBody['scratchDeleted'], previewBody['scratchCount'], 'scratch');
  assert.equal(deleteBody['kgDeleted'], previewBody['kgCount'], 'MemorableKnowledge');
  assert.equal(deleteBody['conversationDeleted'], previewBody['conversationCount'], 'conversation');
}

export async function turnCount(kg: InMemoryKnowledgeGraph, scope: string): Promise<number> {
  const session = await kg.getSession(scope);
  return session?.turns.length ?? 0;
}
