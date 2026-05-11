import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import type { Express } from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { DraftStore } from '../../src/plugins/builder/draftStore.js';
import { DraftQuota } from '../../src/plugins/builder/draftQuota.js';
import { SpecEventBus, type SpecBusEvent } from '../../src/plugins/builder/specEventBus.js';
import { createBuilderRouter } from '../../src/routes/builder.js';

function withSessionEmail(email: string | null): express.RequestHandler {
  return (req, _res, next) => {
    (req as unknown as { session: { email: string | null } }).session = { email };
    next();
  };
}

interface RebuildCall {
  userEmail: string;
  draftId: string;
}

interface TestApp {
  server: Server;
  baseUrl: string;
  draftStore: DraftStore;
  draftId: string;
  userEmail: string;
  bus: SpecEventBus;
  events: SpecBusEvent[];
  rebuilds: RebuildCall[];
  tmpRoot: string;
  close: () => Promise<void>;
}

async function createTestApp(opts: { email?: string | null } = {}): Promise<TestApp> {
  const tmpRoot = mkdtempSync(path.join(tmpdir(), 'builder-edit-routes-'));
  const dbPath = path.join(tmpRoot, 'drafts.db');
  const draftStore = new DraftStore({ dbPath });
  await draftStore.open();
  const userEmail = 'tester@example.com';
  const draft = await draftStore.create(userEmail, 'Test');
  const bus = new SpecEventBus();
  const events: SpecBusEvent[] = [];
  bus.subscribe(draft.id, (e) => events.push(e));

  const rebuilds: RebuildCall[] = [];
  const draftQuota = new DraftQuota({ store: draftStore, max: 50 });

  const app: Express = express();
  app.use(express.json());
  app.use(withSessionEmail(opts.email === undefined ? userEmail : opts.email));
  app.use(
    '/api/v1/builder',
    createBuilderRouter({
      store: draftStore,
      quota: draftQuota,
      editing: {
        draftStore,
        bus,
        rebuildScheduler: {
          schedule(email: string, draftId: string) {
            rebuilds.push({ userEmail: email, draftId });
          },
        },
      },
    }),
  );

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;

  return {
    server,
    baseUrl: `http://127.0.0.1:${String(port)}`,
    draftStore,
    draftId: draft.id,
    userEmail,
    bus,
    events,
    rebuilds,
    tmpRoot,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await draftStore.close();
      rmSync(tmpRoot, { recursive: true, force: true });
    },
  };
}

async function patchJson(
  baseUrl: string,
  url: string,
  body: unknown,
): Promise<{ status: number; json: Record<string, unknown> | null }> {
  const res = await fetch(`${baseUrl}${url}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  let json: Record<string, unknown> | null = null;
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

describe('PATCH /api/v1/builder/drafts/:id/spec', () => {
  let app: TestApp;
  afterEach(async () => {
    if (app) await app.close();
  });

  it('applies patches, emits user-cause spec_patch, schedules rebuild', async () => {
    app = await createTestApp();
    const result = await patchJson(
      app.baseUrl,
      `/api/v1/builder/drafts/${app.draftId}/spec`,
      {
        patches: [
          { op: 'replace', path: '/name', value: 'Renamed' },
          { op: 'replace', path: '/description', value: 'updated description' },
        ],
      },
    );
    assert.equal(result.status, 200);

    const reloaded = await app.draftStore.load(app.userEmail, app.draftId);
    assert.equal(reloaded?.spec.name, 'Renamed');
    assert.equal(reloaded?.spec.description, 'updated description');

    assert.equal(app.events.length, 1);
    assert.equal(app.events[0].type, 'spec_patch');
    if (app.events[0].type === 'spec_patch') {
      assert.equal(app.events[0].cause, 'user');
      assert.equal(app.events[0].patches.length, 2);
    }

    assert.equal(app.rebuilds.length, 1);
    assert.equal(app.rebuilds[0].userEmail, app.userEmail);
    assert.equal(app.rebuilds[0].draftId, app.draftId);
  });

  it('rejects with 401 when no session', async () => {
    app = await createTestApp({ email: null });
    const result = await patchJson(
      app.baseUrl,
      `/api/v1/builder/drafts/${app.draftId}/spec`,
      { patches: [{ op: 'replace', path: '/name', value: 'X' }] },
    );
    assert.equal(result.status, 401);
  });

  it('rejects with 400 on empty patches array', async () => {
    app = await createTestApp();
    const result = await patchJson(
      app.baseUrl,
      `/api/v1/builder/drafts/${app.draftId}/spec`,
      { patches: [] },
    );
    assert.equal(result.status, 400);
    assert.equal(result.json?.['code'], 'builder.invalid_patches');
  });

  it('rejects with 400 on malformed patch shape', async () => {
    app = await createTestApp();
    const result = await patchJson(
      app.baseUrl,
      `/api/v1/builder/drafts/${app.draftId}/spec`,
      { patches: [{ op: 'move', path: '/x', from: '/y' }] },
    );
    assert.equal(result.status, 400);
    assert.equal(result.json?.['code'], 'builder.invalid_patches');
    assert.equal(app.rebuilds.length, 0);
    assert.equal(app.events.length, 0);
  });

  it('returns 400 when patch fails to apply (illegal pointer)', async () => {
    app = await createTestApp();
    const result = await patchJson(
      app.baseUrl,
      `/api/v1/builder/drafts/${app.draftId}/spec`,
      { patches: [{ op: 'remove', path: '/slots/missing' }] },
    );
    assert.equal(result.status, 400);
    assert.equal(result.json?.['code'], 'builder.illegal_patch');
    assert.equal(app.rebuilds.length, 0);
    assert.equal(app.events.length, 0);
  });

  it('returns 404 for unknown draft id', async () => {
    app = await createTestApp();
    const result = await patchJson(
      app.baseUrl,
      `/api/v1/builder/drafts/no-such-draft/spec`,
      { patches: [{ op: 'replace', path: '/name', value: 'X' }] },
    );
    assert.equal(result.status, 404);
  });

  it('cross-user ownership: user B cannot patch user A draft', async () => {
    app = await createTestApp(); // logged in as tester@example.com
    // Re-mount router with a different user but pointing at same store/draft
    const otherApp: Express = express();
    otherApp.use(express.json());
    otherApp.use(withSessionEmail('other@example.com'));
    const draftQuota = new DraftQuota({ store: app.draftStore, max: 50 });
    otherApp.use(
      '/api/v1/builder',
      createBuilderRouter({
        store: app.draftStore,
        quota: draftQuota,
        editing: {
          draftStore: app.draftStore,
          bus: app.bus,
          rebuildScheduler: { schedule: () => app.rebuilds.push({ userEmail: 'other@example.com', draftId: 'unexpected' }) },
        },
      }),
    );
    const otherServer: Server = await new Promise((resolve) => {
      const s = otherApp.listen(0, () => resolve(s));
    });
    const otherPort = (otherServer.address() as AddressInfo).port;
    try {
      const result = await patchJson(
        `http://127.0.0.1:${String(otherPort)}`,
        `/api/v1/builder/drafts/${app.draftId}/spec`,
        { patches: [{ op: 'replace', path: '/name', value: 'pwned' }] },
      );
      assert.equal(result.status, 404);
      assert.equal(app.rebuilds.length, 0);
    } finally {
      await new Promise<void>((resolve) => otherServer.close(() => resolve()));
    }
  });
});

describe('PATCH /api/v1/builder/drafts/:id/slot', () => {
  let app: TestApp;
  afterEach(async () => {
    if (app) await app.close();
  });

  it('overwrites slot, emits user-cause slot_patch, schedules rebuild', async () => {
    app = await createTestApp();
    const result = await patchJson(
      app.baseUrl,
      `/api/v1/builder/drafts/${app.draftId}/slot`,
      { slotKey: 'activate-body', source: 'init();' },
    );
    assert.equal(result.status, 200);

    const reloaded = await app.draftStore.load(app.userEmail, app.draftId);
    assert.equal(reloaded?.slots['activate-body'], 'init();');

    assert.equal(app.events.length, 1);
    if (app.events[0].type === 'slot_patch') {
      assert.equal(app.events[0].cause, 'user');
      assert.equal(app.events[0].slotKey, 'activate-body');
    }
    assert.equal(app.rebuilds.length, 1);
  });

  it('rejects invalid slotKey', async () => {
    app = await createTestApp();
    const result = await patchJson(
      app.baseUrl,
      `/api/v1/builder/drafts/${app.draftId}/slot`,
      { slotKey: 'BadKey', source: 'x' },
    );
    assert.equal(result.status, 400);
    assert.equal(result.json?.['code'], 'builder.invalid_slot_key');
    assert.equal(app.rebuilds.length, 0);
  });

  it('rejects non-string source', async () => {
    app = await createTestApp();
    const result = await patchJson(
      app.baseUrl,
      `/api/v1/builder/drafts/${app.draftId}/slot`,
      { slotKey: 'foo', source: 42 },
    );
    assert.equal(result.status, 400);
    assert.equal(result.json?.['code'], 'builder.invalid_slot_source');
  });

  it('returns 404 for unknown draft id', async () => {
    app = await createTestApp();
    const result = await patchJson(
      app.baseUrl,
      `/api/v1/builder/drafts/no-such-draft/slot`,
      { slotKey: 'foo', source: 'x' },
    );
    assert.equal(result.status, 404);
  });

  it('rejects 401 when no session', async () => {
    app = await createTestApp({ email: null });
    const result = await patchJson(
      app.baseUrl,
      `/api/v1/builder/drafts/${app.draftId}/slot`,
      { slotKey: 'foo', source: 'x' },
    );
    assert.equal(result.status, 401);
  });
});

describe('PATCH /api/v1/builder/drafts/:id/model', () => {
  let app: TestApp;
  afterEach(async () => {
    if (app) await app.close();
  });

  it('updates codegenModel and DOES NOT trigger rebuild', async () => {
    app = await createTestApp();
    const result = await patchJson(
      app.baseUrl,
      `/api/v1/builder/drafts/${app.draftId}/model`,
      { codegenModel: 'opus' },
    );
    assert.equal(result.status, 200);

    const reloaded = await app.draftStore.load(app.userEmail, app.draftId);
    assert.equal(reloaded?.codegenModel, 'opus');
    assert.equal(app.rebuilds.length, 0);
    assert.equal(app.events.length, 0);
  });

  it('updates previewModel without rebuild', async () => {
    app = await createTestApp();
    const result = await patchJson(
      app.baseUrl,
      `/api/v1/builder/drafts/${app.draftId}/model`,
      { previewModel: 'haiku' },
    );
    assert.equal(result.status, 200);
    const reloaded = await app.draftStore.load(app.userEmail, app.draftId);
    assert.equal(reloaded?.previewModel, 'haiku');
    assert.equal(app.rebuilds.length, 0);
  });

  it('rejects invalid model id', async () => {
    app = await createTestApp();
    const result = await patchJson(
      app.baseUrl,
      `/api/v1/builder/drafts/${app.draftId}/model`,
      { codegenModel: 'gpt-4' },
    );
    assert.equal(result.status, 400);
    assert.equal(result.json?.['code'], 'builder.invalid_model');
  });

  it('rejects request with neither model field set', async () => {
    app = await createTestApp();
    const result = await patchJson(
      app.baseUrl,
      `/api/v1/builder/drafts/${app.draftId}/model`,
      {},
    );
    assert.equal(result.status, 400);
    assert.equal(result.json?.['code'], 'builder.invalid_model');
  });
});

describe('Auto-rebuild end-to-end', () => {
  let app: TestApp;
  afterEach(async () => {
    if (app) await app.close();
  });

  it('a sequence of spec + slot edits each triggers exactly one rebuild', async () => {
    app = await createTestApp();
    await patchJson(
      app.baseUrl,
      `/api/v1/builder/drafts/${app.draftId}/spec`,
      { patches: [{ op: 'replace', path: '/name', value: 'A' }] },
    );
    await patchJson(
      app.baseUrl,
      `/api/v1/builder/drafts/${app.draftId}/slot`,
      { slotKey: 'a', source: 'a();' },
    );
    await patchJson(
      app.baseUrl,
      `/api/v1/builder/drafts/${app.draftId}/spec`,
      { patches: [{ op: 'replace', path: '/name', value: 'B' }] },
    );
    assert.equal(app.rebuilds.length, 3);
    assert.equal(app.events.length, 3);
  });
});
