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
import {
  GithubIssueCache,
  type CacheFetch,
} from '../../src/plugins/builder/githubIssueCache.js';
import { SpecEventBus } from '../../src/plugins/builder/specEventBus.js';
import { UserChoiceCoordinator } from '../../src/plugins/builder/userChoiceCoordinator.js';
import { createBuilderRouter } from '../../src/routes/builder.js';

interface TestApp {
  server: Server;
  baseUrl: string;
  store: DraftStore;
  draftId: string;
  userEmail: string;
  coord: UserChoiceCoordinator;
  cache: GithubIssueCache;
  bus: SpecEventBus;
  tmpRoot: string;
  close(): Promise<void>;
}

function mockResponse(opts: {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}) {
  const headers = new Map(
    Object.entries(opts.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return {
    ok: opts.status >= 200 && opts.status < 300,
    status: opts.status,
    headers: { get: (n: string) => headers.get(n.toLowerCase()) ?? null },
    json: () => Promise.resolve(opts.body ?? {}),
  };
}

async function createTestApp(fetch: CacheFetch): Promise<TestApp> {
  const tmpRoot = mkdtempSync(path.join(tmpdir(), 'issue-routes-'));
  const dbPath = path.join(tmpRoot, 'drafts.db');
  const store = new DraftStore({ dbPath });
  await store.open();
  const userEmail = 'tester@example.com';
  const draft = await store.create(userEmail, 'Issue Route Test');

  const bus = new SpecEventBus();
  const coord = new UserChoiceCoordinator({ bus, timeoutMs: 5000 });
  const cache = new GithubIssueCache({ dbPath, fetch });
  await cache.open();

  const app: Express = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: { email: string } }).session = {
      email: userEmail,
    };
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
    coord,
    cache,
    bus,
    tmpRoot,
    async close() {
      coord.cancelAll();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await cache.close();
      await store.close();
      rmSync(tmpRoot, { recursive: true, force: true });
    },
  };
}

describe('builderIssueReporting — user-choice route', () => {
  let app: TestApp;

  afterEach(async () => {
    if (app) await app.close();
  });

  it('resolves a pending choice when the operator picks an option', async () => {
    app = await createTestApp(() =>
      Promise.resolve(mockResponse({ status: 200, body: {} })),
    );
    const { choiceId, result } = app.coord.create({
      draftId: app.draftId,
      question: 'Workaround?',
      options: [
        { value: 'workaround', label: 'Workaround' },
        { value: 'pause', label: 'Pause' },
      ],
    });
    const response = await fetch(
      `${app.baseUrl}/api/v1/builder/drafts/${app.draftId}/user-choice/${choiceId}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ value: 'pause' }),
      },
    );
    assert.equal(response.status, 200);
    const outcome = await result;
    assert.deepEqual(outcome, { ok: true, choiceId, value: 'pause' });
  });

  it('returns 404 for unknown choiceIds', async () => {
    app = await createTestApp(() =>
      Promise.resolve(mockResponse({ status: 200, body: {} })),
    );
    const response = await fetch(
      `${app.baseUrl}/api/v1/builder/drafts/${app.draftId}/user-choice/nope`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ value: 'whatever' }),
      },
    );
    assert.equal(response.status, 404);
  });
});

describe('builderIssueReporting — confirm-issue route', () => {
  let app: TestApp;

  afterEach(async () => {
    if (app) await app.close();
  });

  it('persists the workaround on a valid confirm', async () => {
    const fingerprint = 'feedface0001';
    const fetch: CacheFetch = () =>
      Promise.resolve(
        mockResponse({
          status: 200,
          body: {
            state: 'open',
            closed_at: null,
            html_url: 'https://github.com/byte5ai/omadia/issues/123',
            body: `repro\n\n<!-- omadia-fingerprint: ${fingerprint} -->\n`,
            labels: [
              { name: 'from-builder-bot' },
              { name: 'needs-triage' },
            ],
          },
        }),
      );
    app = await createTestApp(fetch);
    const response = await globalThis.fetch(
      `${app.baseUrl}/api/v1/builder/drafts/${app.draftId}/workarounds/confirm-issue`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          issueNumber: 123,
          fingerprint,
          summary: 'workaround for codegen union bug',
        }),
      },
    );
    assert.equal(response.status, 200);
    const payload = (await response.json()) as {
      ok: boolean;
      workaround: { id: string; fingerprint: string };
    };
    assert.equal(payload.ok, true);
    assert.equal(payload.workaround.fingerprint, fingerprint);

    const reloaded = await app.store.load(app.userEmail, app.draftId);
    assert.ok(reloaded);
    const workarounds = reloaded.spec.builder_settings?.workarounds ?? [];
    assert.equal(workarounds.length, 1);
    assert.equal(workarounds[0]?.fingerprint, fingerprint);
    assert.equal(workarounds[0]?.issueRef.number, 123);
  });

  it('returns 422 when the issue body is missing the fingerprint marker', async () => {
    const fetch: CacheFetch = () =>
      Promise.resolve(
        mockResponse({
          status: 200,
          body: {
            state: 'open',
            closed_at: null,
            html_url: 'https://github.com/byte5ai/omadia/issues/124',
            body: 'just an unrelated issue',
            labels: [{ name: 'from-builder-bot' }, { name: 'needs-triage' }],
          },
        }),
      );
    app = await createTestApp(fetch);
    const response = await globalThis.fetch(
      `${app.baseUrl}/api/v1/builder/drafts/${app.draftId}/workarounds/confirm-issue`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          issueNumber: 124,
          fingerprint: 'expected-hash',
          summary: 's',
        }),
      },
    );
    assert.equal(response.status, 422);
    const payload = (await response.json()) as { code: string };
    assert.equal(payload.code, 'builder.confirm_issue_fingerprint_mismatch');
  });

  it('returns 422 when the from-builder-bot label is missing', async () => {
    const fingerprint = 'abc123';
    const fetch: CacheFetch = () =>
      Promise.resolve(
        mockResponse({
          status: 200,
          body: {
            state: 'open',
            closed_at: null,
            html_url: 'https://github.com/byte5ai/omadia/issues/125',
            body: `body\n<!-- omadia-fingerprint: ${fingerprint} -->`,
            labels: [{ name: 'bug' }],
          },
        }),
      );
    app = await createTestApp(fetch);
    const response = await globalThis.fetch(
      `${app.baseUrl}/api/v1/builder/drafts/${app.draftId}/workarounds/confirm-issue`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          issueNumber: 125,
          fingerprint,
          summary: 's',
        }),
      },
    );
    assert.equal(response.status, 422);
    const payload = (await response.json()) as { code: string };
    assert.equal(payload.code, 'builder.confirm_issue_missing_labels');
  });

  it('returns 422 when the issue is 404 in the upstream repo', async () => {
    const fetch: CacheFetch = () =>
      Promise.resolve(mockResponse({ status: 404 }));
    app = await createTestApp(fetch);
    const response = await globalThis.fetch(
      `${app.baseUrl}/api/v1/builder/drafts/${app.draftId}/workarounds/confirm-issue`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          issueNumber: 9999,
          fingerprint: 'whatever',
          summary: 's',
        }),
      },
    );
    assert.equal(response.status, 422);
    const payload = (await response.json()) as { code: string };
    assert.equal(payload.code, 'builder.confirm_issue_not_found');
  });

  it('returns 400 when payload is malformed', async () => {
    app = await createTestApp(() =>
      Promise.resolve(mockResponse({ status: 200, body: {} })),
    );
    const response = await globalThis.fetch(
      `${app.baseUrl}/api/v1/builder/drafts/${app.draftId}/workarounds/confirm-issue`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ issueNumber: 'not-a-number' }),
      },
    );
    assert.equal(response.status, 400);
  });
});
