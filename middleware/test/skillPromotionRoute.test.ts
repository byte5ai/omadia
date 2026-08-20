/**
 * #778 W1 — the HTTP surface for `PgSkillOwnershipLifecycleStore.promoteSkillOwnerScope`
 * (#577 P3), end to end against a real Express app (`app.listen(0, ...)` +
 * real `fetch`), the same pattern `credentialAskRoutes.test.ts` and
 * `adminProvidersRoute.test.ts` use.
 *
 * `store` is a fake implementing only `promoteSkillOwnerScope` — the route's
 * deps type is deliberately `Pick<PgSkillOwnershipLifecycleStore,
 * 'promoteSkillOwnerScope'>` so this test never needs a real `Pool`. The
 * store's own promotion logic (published-only gate, cron-actor guard,
 * re-signing) is covered by `test/skillOwnershipLifecycleStore.pg.test.ts`;
 * this file covers the ROUTE layer only: session auth (the precedent this
 * route was explicitly required to replicate exactly from
 * `routes/bulkPromotion.ts`), request validation, and error-to-status
 * mapping.
 */

import { strict as assert } from 'node:assert';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';

import express, { type Express } from 'express';

import { createSkillPromotionRouter, type SkillPromotionRouteDeps } from '../src/routes/skillPromotion.js';
import { SkillAutomationWriteBlocked } from '../src/services/skillLifecycle.js';
import type { PgSkillOwnershipLifecycleStore } from '../src/services/skillLifecycleStore.js';
import type { ScopeId } from '@omadia/channel-sdk';

type PromoteArgs = Parameters<PgSkillOwnershipLifecycleStore['promoteSkillOwnerScope']>;

class FakeSkillLifecycleStore {
  public calls: PromoteArgs[] = [];
  public behavior: 'ok' | 'not-found' | 'not-published' | 'automation-blocked' = 'ok';

  async promoteSkillOwnerScope(...args: PromoteArgs) {
    this.calls.push(args);
    const [skillId, targetScope] = args;
    if (this.behavior === 'not-found') {
      throw new Error(`skill ${skillId} not found`);
    }
    if (this.behavior === 'not-published') {
      throw new Error(`skill ${skillId} is not published (status: draft) — only a published skill may be promoted`);
    }
    if (this.behavior === 'automation-blocked') {
      throw new SkillAutomationWriteBlocked({ kind: 'system', origin: 'cron', id: 'x' } as ScopeId);
    }
    return {
      id: skillId,
      slug: 'demo-skill',
      name: 'Demo Skill',
      frontmatter: {},
      body: '',
      ownerScope:
        targetScope.kind === 'group' ? `group:${targetScope.groupRef}` : `org:${targetScope.orgId}`,
      lifecycleStatus: 'published' as const,
      manifestSignature: 'deadbeef',
      manifestSignedAt: new Date('2026-08-20T12:00:00Z'),
    };
  }
}

function buildApp(store: FakeSkillLifecycleStore, deps: Partial<SkillPromotionRouteDeps> = {}): Express {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/admin/skills', (req, _res, next) => {
    const withSession = req as typeof req & { session?: { omadia_user_id?: string } };
    // Stand in for requireAuth, which the real mount puts in front of this
    // router — a query flag lets individual tests exercise the "no session"
    // (401) path without a second app instance.
    if (req.query['noSession'] !== '1') {
      withSession.session = { omadia_user_id: 'op-1' };
    }
    next();
  });
  app.use(
    '/api/v1/admin/skills',
    createSkillPromotionRouter({ store, signingKey: 'test-signing-key', ...deps }),
  );
  return app;
}

async function withServer<T>(app: Express, run: (baseUrl: string) => Promise<T>): Promise<T> {
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  try {
    return await run(`http://127.0.0.1:${String(port)}/api/v1/admin/skills`);
  } finally {
    await new Promise((resolve) => server.close(() => resolve(undefined)));
  }
}

async function postJson(url: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('#778 W1 skill-promotion route', () => {
  it('401s with auth.required when no session is present', async () => {
    const store = new FakeSkillLifecycleStore();
    const app = buildApp(store);
    await withServer(app, async (baseUrl) => {
      const res = await postJson(`${baseUrl}/skill-1/promote?noSession=1`, {
        targetScope: { kind: 'org', orgId: 'byte5' },
      });
      assert.equal(res.status, 401);
      assert.equal(res.body['code'], 'auth.required');
      assert.equal(store.calls.length, 0, 'the store must never be called without a session');
    });
  });

  it('400s on a malformed targetScope', async () => {
    const store = new FakeSkillLifecycleStore();
    const app = buildApp(store);
    await withServer(app, async (baseUrl) => {
      const res = await postJson(`${baseUrl}/skill-1/promote`, { targetScope: { kind: 'personal' } });
      assert.equal(res.status, 400);
      assert.equal(res.body['code'], 'skill_promotion.invalid_request');
      assert.equal(store.calls.length, 0);
    });
  });

  it('promotes to an org scope and echoes the actorScope built from the session', async () => {
    const store = new FakeSkillLifecycleStore();
    const app = buildApp(store);
    await withServer(app, async (baseUrl) => {
      const res = await postJson(`${baseUrl}/skill-1/promote`, {
        targetScope: { kind: 'org', orgId: 'byte5' },
      });
      assert.equal(res.status, 200);
      assert.equal(res.body['ownerScope'], 'org:byte5');
      assert.equal(store.calls.length, 1);
      const [skillId, targetScope, opts] = store.calls[0]!;
      assert.equal(skillId, 'skill-1');
      assert.deepEqual(targetScope, { kind: 'org', orgId: 'byte5' });
      assert.deepEqual(opts.actorScope, { kind: 'personal', userId: 'op-1' });
      assert.equal(opts.signingKey, 'test-signing-key');
    });
  });

  it('promotes to a group (team) scope', async () => {
    const store = new FakeSkillLifecycleStore();
    const app = buildApp(store);
    await withServer(app, async (baseUrl) => {
      const res = await postJson(`${baseUrl}/skill-2/promote`, {
        targetScope: { kind: 'group', groupRef: 'platform-team' },
      });
      assert.equal(res.status, 200);
      assert.equal(res.body['ownerScope'], 'group:platform-team');
    });
  });

  it('404s when the store reports the skill was not found', async () => {
    const store = new FakeSkillLifecycleStore();
    store.behavior = 'not-found';
    const app = buildApp(store);
    await withServer(app, async (baseUrl) => {
      const res = await postJson(`${baseUrl}/missing/promote`, { targetScope: { kind: 'org', orgId: 'byte5' } });
      assert.equal(res.status, 404);
      assert.equal(res.body['code'], 'skill_promotion.not_found');
    });
  });

  it('409s when the store refuses an unpublished skill', async () => {
    const store = new FakeSkillLifecycleStore();
    store.behavior = 'not-published';
    const app = buildApp(store);
    await withServer(app, async (baseUrl) => {
      const res = await postJson(`${baseUrl}/draft-1/promote`, { targetScope: { kind: 'org', orgId: 'byte5' } });
      assert.equal(res.status, 409);
      assert.equal(res.body['code'], 'skill_promotion.not_eligible');
    });
  });

  it('403s when the store rejects a machine actor (defensive branch)', async () => {
    const store = new FakeSkillLifecycleStore();
    store.behavior = 'automation-blocked';
    const app = buildApp(store);
    await withServer(app, async (baseUrl) => {
      const res = await postJson(`${baseUrl}/skill-1/promote`, { targetScope: { kind: 'org', orgId: 'byte5' } });
      assert.equal(res.status, 403);
      assert.equal(res.body['code'], 'skill_promotion.automation_blocked');
    });
  });
});
