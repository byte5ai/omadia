/**
 * #2320 — `/api/v1/admin/publish` against a real Express app with the
 * in-memory publish store. Pins: 503 without a database, newest version
 * first with the live one marked, slug validation, 404 for an unknown app,
 * and that the router offers no write.
 */

import { strict as assert } from 'node:assert';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';

import express, { type Express } from 'express';

import { InMemoryPublishStore } from '@omadia/publish';

import { createAdminPublishRouter, type AdminPublishRouteDeps } from '../src/routes/adminPublish.js';

function buildApp(deps: AdminPublishRouteDeps): Express {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/admin/publish', createAdminPublishRouter(deps));
  return app;
}

async function withServer<T>(app: Express, run: (base: string) => Promise<T>): Promise<T> {
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  try {
    return await run(`http://127.0.0.1:${String(port)}/api/v1/admin/publish`);
  } finally {
    await new Promise((resolve) => server.close(() => resolve(undefined)));
  }
}

async function seeded(): Promise<InMemoryPublishStore> {
  const store = new InMemoryPublishStore();
  const now = new Date('2026-11-28T10:00:00Z');
  for (const name of ['v1', 'v2', 'v3']) {
    await store.createVersion({ appId: 'team-board', name, entrypoint: 'server.js', dirHash: `h-${name}`, sourceScopeKey: 'personal:alice', now });
  }
  await store.setPointer('team-board', 2, now);
  return store;
}

describe('#2320 admin publish route', () => {
  it('answers 503 on both reads without a database', async () => {
    await withServer(buildApp({}), async (base) => {
      assert.equal((await fetch(`${base}/apps`)).status, 503);
      assert.equal((await fetch(`${base}/apps/team-board/versions`)).status, 503);
    });
  });

  it('lists apps from the catalog read', async () => {
    const listApps = async () => [
      { appId: 'team-board', name: 'v3', currentVersion: 2, latestVersion: 3, versionCount: 3, updatedAt: new Date('2026-11-28T10:00:00Z') },
    ];
    await withServer(buildApp({ listApps }), async (base) => {
      const body = (await (await fetch(`${base}/apps`)).json()) as { apps: Array<Record<string, unknown>> };
      assert.deepEqual(body.apps[0], {
        app_id: 'team-board',
        name: 'v3',
        current_version: 2,
        latest_version: 3,
        version_count: 3,
        updated_at: '2026-11-28T10:00:00.000Z',
      });
    });
  });

  it('lists versions newest first and marks the live one', async () => {
    const store = await seeded();
    await withServer(buildApp({ store }), async (base) => {
      const res = await fetch(`${base}/apps/team-board/versions`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as { current_version: number; versions: Array<Record<string, unknown>> };
      assert.equal(body.current_version, 2);
      assert.deepEqual(body.versions.map((v) => [v['version'], v['current']]), [[3, false], [2, true], [1, false]]);
    });
  });

  it('400s a non-slug app id and 404s an unknown app', async () => {
    const store = await seeded();
    await withServer(buildApp({ store }), async (base) => {
      assert.equal((await fetch(`${base}/apps/Team_Board/versions`)).status, 400);
      assert.equal((await fetch(`${base}/apps/nope/versions`)).status, 404);
    });
  });

  it('offers no write route', async () => {
    const store = await seeded();
    await withServer(buildApp({ store }), async (base) => {
      const res = await fetch(`${base}/apps/team-board/versions`, { method: 'POST' });
      assert.equal(res.status, 404);
    });
  });
});
