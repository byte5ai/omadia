import { describe, it, afterEach } from 'node:test';
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
import {
  GithubIssueCache,
  type CacheFetch,
} from '../../src/plugins/builder/githubIssueCache.js';
import {
  GithubIssueCreator,
  type CreatorFetch,
} from '../../src/plugins/builder/githubIssueCreator.js';
import { UserChoiceCoordinator } from '../../src/plugins/builder/userChoiceCoordinator.js';
import { SpecEventBus } from '../../src/plugins/builder/specEventBus.js';
import { createBuilderRouter } from '../../src/routes/builder.js';

function cacheResponse(status: number, body: unknown) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: () => Promise.resolve(body),
  });
}

interface Harness {
  server: Server;
  baseUrl: string;
  store: DraftStore;
  draftId: string;
  userEmail: string;
  tmpRoot: string;
  createCalls: number;
  close(): Promise<void>;
}

async function createHarness(opts: {
  cacheFetch: CacheFetch;
  /** Omit to simulate an instance without the GitHub App wired. */
  creatorFetch?: CreatorFetch;
}): Promise<Harness> {
  const tmpRoot = mkdtempSync(path.join(tmpdir(), 'direct-create-'));
  const dbPath = path.join(tmpRoot, 'drafts.db');
  const store = new DraftStore({ dbPath });
  await store.open();
  const userEmail = 'tester@example.com';
  const draft = await store.create(userEmail, 'Direct Create Test');

  const bus = new SpecEventBus();
  const coord = new UserChoiceCoordinator({ bus, timeoutMs: 5000 });
  const cache = new GithubIssueCache({ dbPath, fetch: opts.cacheFetch });
  await cache.open();

  let createCalls = 0;
  const issueCreator = opts.creatorFetch
    ? new GithubIssueCreator({
        tokenProvider: { getToken: () => Promise.resolve('ghs_tok') },
        fetch: (url, init) => {
          createCalls += 1;
          return opts.creatorFetch!(url, init);
        },
      })
    : undefined;

  const app: Express = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: { email: string } }).session = { email: userEmail };
    next();
  });
  app.use(
    '/api/v1/builder',
    createBuilderRouter({
      store,
      quota: new DraftQuota({ store, max: 50 }),
      issueReporting: {
        store,
        userChoice: coord,
        githubIssueCache: cache,
        ...(issueCreator ? { issueCreator } : {}),
        upstream: {
          owner: 'byte5ai',
          repo: 'omadia',
          requiredLabels: ['from-builder-bot', 'needs-triage'],
        },
      },
    }),
  );

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  return {
    server,
    baseUrl,
    store,
    draftId: draft.id,
    userEmail,
    tmpRoot,
    get createCalls() {
      return createCalls;
    },
    async close() {
      coord.cancelAll();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await cache.close();
      await store.close();
      rmSync(tmpRoot, { recursive: true, force: true });
    },
  };
}

function post(h: Harness, payload: unknown) {
  return fetch(
    `${h.baseUrl}/api/v1/builder/drafts/${h.draftId}/workarounds/create-issue`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    },
  );
}

describe('builderIssueReporting — create-issue (direct GitHub App path)', () => {
  let h: Harness;
  afterEach(async () => {
    if (h) await h.close();
  });

  it('creates the issue and persists the workaround when no duplicate exists', async () => {
    h = await createHarness({
      // fingerprint search → no existing issue
      cacheFetch: () => cacheResponse(200, { items: [] }),
      creatorFetch: () =>
        Promise.resolve({
          ok: true,
          status: 201,
          json: () =>
            Promise.resolve({
              number: 555,
              html_url: 'https://github.com/byte5ai/omadia/issues/555',
            }),
        }),
    });
    const res = await post(h, {
      title: 'Codegen emits invalid TS for nested unions',
      body: 'Repro with secret token=ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa here',
      fingerprint: 'deadbeefcafe',
      summary: 'codegen union bug',
    });
    assert.equal(res.status, 201);
    const payload = (await res.json()) as {
      ok: boolean;
      mode: string;
      issueRef: { number: number };
    };
    assert.equal(payload.ok, true);
    assert.equal(payload.mode, 'created');
    assert.equal(payload.issueRef.number, 555);
    assert.equal(h.createCalls, 1);

    const reloaded = await h.store.load(h.userEmail, h.draftId);
    const workarounds = reloaded?.spec.builder_settings?.workarounds ?? [];
    assert.equal(workarounds.length, 1);
    assert.equal(workarounds[0]?.issueRef.number, 555);
  });

  it('reuses an existing issue (no create call) when the fingerprint already has one', async () => {
    h = await createHarness({
      cacheFetch: () =>
        cacheResponse(200, {
          items: [
            {
              number: 42,
              state: 'open',
              html_url: 'https://github.com/byte5ai/omadia/issues/42',
            },
          ],
        }),
      creatorFetch: () =>
        Promise.resolve({ ok: true, status: 201, json: () => Promise.resolve({ number: 999 }) }),
    });
    const res = await post(h, {
      title: 'Duplicate of an existing bug',
      body: 'repro',
      fingerprint: 'deadbeefcafe',
      summary: 's',
    });
    assert.equal(res.status, 200);
    const payload = (await res.json()) as { mode: string };
    assert.equal(payload.mode, 'reused');
    assert.equal(h.createCalls, 0, 'must not create a duplicate');
  });

  it('returns 409 when no GitHub App is wired (falls back to browser-submit)', async () => {
    h = await createHarness({
      cacheFetch: () => cacheResponse(200, { items: [] }),
      // no creatorFetch → issueCreator undefined
    });
    const res = await post(h, {
      title: 'Some bug',
      body: 'repro',
      fingerprint: 'abc12345',
      summary: 's',
    });
    assert.equal(res.status, 409);
    const payload = (await res.json()) as { code: string };
    assert.equal(payload.code, 'builder.direct_create_unavailable');
  });

  it('surfaces a GitHub validation error as 502', async () => {
    h = await createHarness({
      cacheFetch: () => cacheResponse(200, { items: [] }),
      creatorFetch: () =>
        Promise.resolve({ ok: false, status: 422, json: () => Promise.resolve({}) }),
    });
    const res = await post(h, {
      title: 'Bug that GitHub rejects',
      body: 'repro',
      fingerprint: 'abc12345',
      summary: 's',
    });
    assert.equal(res.status, 502);
    const payload = (await res.json()) as { code: string };
    assert.equal(payload.code, 'builder.create_issue_validation');
  });

  it('returns 400 on a malformed payload', async () => {
    h = await createHarness({
      cacheFetch: () => cacheResponse(200, { items: [] }),
      creatorFetch: () =>
        Promise.resolve({ ok: true, status: 201, json: () => Promise.resolve({ number: 1 }) }),
    });
    const res = await post(h, { title: 'only a title' });
    assert.equal(res.status, 400);
  });
});
