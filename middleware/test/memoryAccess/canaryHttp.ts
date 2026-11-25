/**
 * Canary sweep over the per-person REST routes (memory-ACL plan step 3):
 * `/api/v1/memory`, `/api/v1/datasets`, `/api/chat/sessions`, and the two
 * admin routers that filter per viewer (`/api/v1/admin/topics`,
 * `/api/v1/admin/duplicates`), mounted from
 * the production routers over the seeded stores, called as each person of
 * each tenant. Besides the lists, every read-by-id route is called with every
 * id the world holds, in both tenants: a route that trusts the id would hand
 * out what the list hides.
 *
 * Every canary in a response body is checked against `expectedHttp`.
 */
import express, { type Express, type NextFunction, type Request, type Response } from 'express';

import { ChatSessionStore } from '@omadia/orchestrator';
import { createTopicClusteringService } from '@omadia/orchestrator-extras';

import { createChatSessionsRouter } from '../../src/routes/chatSessions.js';
import { createDatasetsRouter } from '../../src/routes/datasets.js';
import { createDuplicatesRouter } from '../../src/routes/duplicates.js';
import { createMemoryRouter } from '../../src/routes/memory.js';
import { createTopicsRouter } from '../../src/routes/topics.js';
import { invoke } from '../_helpers/httpInvoke.js';
import { expectedHttp, type Verdict } from './oracle.js';
import { chatSessionId, type Seeded } from './seed.js';
import type { Item, TenantKey, UserKey } from './world.js';

export type HttpRoute =
  | 'GET /api/v1/memory'
  | 'GET /api/v1/memory/:id'
  | 'GET /api/v1/memory/:id/excerpts'
  | 'GET /api/v1/memory/:id/audit'
  | 'GET /api/v1/datasets'
  | 'GET /api/v1/datasets/:id'
  | 'GET /api/v1/datasets/:id/rows'
  | 'GET /api/chat/sessions'
  | 'GET /api/chat/sessions/:id'
  | 'GET /api/v1/admin/topics'
  | 'GET /api/v1/admin/topics/:id'
  | 'GET /api/v1/admin/duplicates'
  | 'GET /api/v1/admin/duplicates/:id'
  | 'GET /api/v1/admin/duplicates/excerpts'
  | 'GET /api/v1/admin/duplicates/excerpts/:id';

export interface HttpSighting {
  readonly route: HttpRoute;
  readonly canary: string;
  readonly item: Item;
  readonly verdict: Verdict;
}

const CANARY = /CANARY-[A-Z]+-\d{5}Z/gi;

/**
 * Near-duplicate markers for the duplicates routes: each memory paired with
 * the next one of its tenant, and the same for their excerpts, so most pairs
 * join two different owners. Returns the marker ids of both tenants.
 */
export async function seedDuplicates(
  seeded: Seeded,
): Promise<{ memories: string[]; excerpts: string[] }> {
  const out = { memories: [] as string[], excerpts: [] as string[] };
  for (const tenant of ['main', 'other'] as const) {
    const { graph } = seeded.stores[tenant];
    const mkIds = [
      ...new Set(
        seeded.world.byStore['memorable-knowledge']
          .filter((m) => m.tenant === tenant)
          .map((m) => seeded.location.get(m.canary))
          .filter((id): id is string => id !== undefined),
      ),
    ];
    for (let i = 0; i + 1 < mkIds.length; i++) {
      const mc = await graph.createMergeCandidate({
        mkAExternalId: mkIds[i]!,
        mkBExternalId: mkIds[i + 1]!,
        cosineSim: 0.97,
      });
      if (mc) out.memories.push(mc.id);
      const [exA] = await graph.listExcerptsForMemory(mkIds[i]!);
      const [exB] = await graph.listExcerptsForMemory(mkIds[i + 1]!);
      if (!exA || !exB) continue;
      const emc = await graph.createExcerptMergeCandidate({
        excerptAExternalId: exA.id,
        excerptBExternalId: exB.id,
        cosineSim: 0.98,
      });
      if (emc) out.excerpts.push(emc.id);
    }
  }
  return out;
}

/** The routers as `index.ts` mounts them, behind a fixed session. */
function appFor(seeded: Seeded, tenant: TenantKey, omadiaUserId: string): Express {
  const { graph, memory } = seeded.stores[tenant];
  const app = express();
  app.use(express.json());
  // What `requireAuth` leaves behind: a verified session naming the user.
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as unknown as { session: unknown }).session = { omadia_user_id: omadiaUserId };
    next();
  });
  app.use('/api/v1/memory', createMemoryRouter({ graph }));
  app.use('/api/v1/datasets', createDatasetsRouter({ graph }));
  const chats = new ChatSessionStore(memory);
  app.use('/api/chat', createChatSessionsRouter({ getStore: () => chats }));
  app.use('/api/v1/admin/topics', createTopicsRouter({ service: createTopicClusteringService({ kg: graph }) }));
  app.use('/api/v1/admin/duplicates', createDuplicatesRouter({ graph }));
  return app;
}

/** Every response `user` of `tenant` gets from the per-person routes. */
export async function sweepHttp(
  seeded: Seeded,
  tenant: TenantKey,
  user: UserKey,
  duplicates: { memories: readonly string[]; excerpts: readonly string[] },
): Promise<HttpSighting[]> {
  const app = appFor(seeded, tenant, seeded.users[tenant][user]);
  const byCanary = new Map(seeded.world.items.map((i) => [i.canary, i]));
  const sightings: HttpSighting[] = [];
  const call = async (route: HttpRoute, url: string): Promise<void> => {
    const res = await invoke(app, 'GET', url);
    for (const m of new Set([...res.text.matchAll(CANARY)].map((x) => x[0].toUpperCase()))) {
      const item = byCanary.get(m);
      if (item) sightings.push({ route, canary: m, item, verdict: expectedHttp(user, tenant, item) });
    }
  };

  // Ids of both tenants: the other tenant's ids must not open anything either.
  const at = (store: Item['store']): string[] => [
    ...new Set(
      seeded.world.items
        .filter((i) => i.store === store)
        .map((i) => seeded.location.get(i.canary))
        .filter((id): id is string => id !== undefined),
    ),
  ];

  await call('GET /api/v1/memory', '/api/v1/memory?limit=500');
  for (const id of at('memorable-knowledge')) {
    const e = encodeURIComponent(id);
    await call('GET /api/v1/memory/:id', `/api/v1/memory/${e}`);
    await call('GET /api/v1/memory/:id/excerpts', `/api/v1/memory/${e}/excerpts`);
    await call('GET /api/v1/memory/:id/audit', `/api/v1/memory/${e}/audit`);
  }
  await call('GET /api/v1/datasets', '/api/v1/datasets');
  for (const id of at('dataset')) {
    await call('GET /api/v1/datasets/:id', `/api/v1/datasets/${id}`);
    await call('GET /api/v1/datasets/:id/rows', `/api/v1/datasets/${id}/rows`);
  }
  await call('GET /api/chat/sessions', '/api/chat/sessions');
  for (const item of seeded.world.byStore.scratch) {
    if (item.tier !== 'chat-session') continue;
    await call('GET /api/chat/sessions/:id', `/api/chat/sessions/${chatSessionId(item)}`);
  }
  await call('GET /api/v1/admin/topics', '/api/v1/admin/topics');
  for (const id of at('topic')) {
    await call('GET /api/v1/admin/topics/:id', `/api/v1/admin/topics/${encodeURIComponent(id)}`);
  }
  await call('GET /api/v1/admin/duplicates', '/api/v1/admin/duplicates?limit=200');
  for (const id of duplicates.memories) {
    await call('GET /api/v1/admin/duplicates/:id', `/api/v1/admin/duplicates/${encodeURIComponent(id)}`);
  }
  await call('GET /api/v1/admin/duplicates/excerpts', '/api/v1/admin/duplicates/excerpts?limit=200');
  for (const id of duplicates.excerpts) {
    await call(
      'GET /api/v1/admin/duplicates/excerpts/:id',
      `/api/v1/admin/duplicates/excerpts/${encodeURIComponent(id)}`,
    );
  }
  return sightings;
}
