import { strict as assert } from 'node:assert';
import { generateKeyPairSync } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { after, describe, it } from 'node:test';

import express, { type RequestHandler } from 'express';

import {
  createDevPlatformGithubAppRouter,
  type DevPlatformGithubAppDeps,
  type GithubAppStorePort,
} from '../../src/routes/devPlatformGithubApp.js';
import { ManifestFlowStore } from '../../src/devplatform/githubApp/manifestFlow.js';
import type {
  DevGithubApp,
  DevGithubAppInstallation,
  DevGithubAppSecrets,
} from '../../src/devplatform/githubApp/appStore.js';

// A real RSA key so mintAppJwt can actually sign. Generated at runtime — never a
// literal in this file (the fixture below stands in for a real one everywhere else).
const { privateKey: REAL_PEM } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const FAKE_PEM = 'FAKE-PEM-FIXTURE-not-a-key';

type FetchStub = (url: string, init?: unknown) => Promise<Response>;

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

interface StoreState {
  apps: Map<string, DevGithubApp & { installations: number }>;
  installations: Map<string, DevGithubAppInstallation>;
  secrets: Map<string, DevGithubAppSecrets>;
  saved: Array<{ id: number; slug: string; createdBy: string }>;
  upserts: Array<{ appRowId: string; installationId: string; accountLogin: string }>;
}

function makeStore(state: StoreState, failSave = false): GithubAppStorePort {
  return {
    saveApp: async (conv, _apiBaseUrl, createdBy) => {
      if (failSave) throw new Error('vault down');
      state.saved.push({ id: conv.id, slug: conv.slug, createdBy });
      const app: DevGithubApp & { installations: number } = {
        id: `row-${String(conv.id)}`,
        appId: String(conv.id),
        slug: conv.slug,
        ownerLogin: conv.ownerLogin,
        htmlUrl: conv.htmlUrl,
        apiBaseUrl: _apiBaseUrl,
        createdBy,
        installations: 0,
      };
      state.apps.set(app.id, app);
      state.secrets.set(app.appId, { privateKey: conv.pem });
      return app;
    },
    listApps: async () => [...state.apps.values()],
    getApp: async (appRowId) => state.apps.get(appRowId) ?? null,
    getSecrets: async (appId) => state.secrets.get(appId) ?? null,
    upsertInstallation: async (appRowId, installationId, accountLogin) => {
      state.upserts.push({ appRowId, installationId, accountLogin });
      const inst: DevGithubAppInstallation = {
        id: `inst-${installationId}`,
        appRowId,
        installationId,
        accountLogin,
      };
      state.installations.set(installationId, inst);
      return inst;
    },
    findInstallation: async (installationId) => state.installations.get(installationId) ?? null,
  };
}

interface HarnessOpts {
  fetchImpl?: FetchStub;
  bindRepoCredential?: DevPlatformGithubAppDeps['bindRepoCredential'];
  getRepo?: DevPlatformGithubAppDeps['getRepo'];
  recheckBranchProtection?: DevPlatformGithubAppDeps['recheckBranchProtection'];
  flowStore?: ManifestFlowStore;
  seedApp?: boolean;
  failSave?: boolean;
}

async function harness(opts: HarnessOpts = {}) {
  const state: StoreState = {
    apps: new Map(),
    installations: new Map(),
    secrets: new Map(),
    saved: [],
    upserts: [],
  };
  if (opts.seedApp) {
    state.apps.set('row-1', {
      id: 'row-1',
      appId: '4242',
      slug: 'omadia-dev',
      ownerLogin: 'acme',
      htmlUrl: 'https://github.com/apps/omadia-dev',
      apiBaseUrl: 'https://api.github.com',
      createdBy: 'user-1',
      installations: 1,
    });
    state.secrets.set('4242', { privateKey: REAL_PEM });
  }
  const bindCalls: Array<{ repoId: string; appRowId: string; installationId: string }> = [];
  const flowStore = opts.flowStore ?? new ManifestFlowStore();
  const deps: DevPlatformGithubAppDeps = {
    flowStore,
    appStore: makeStore(state, opts.failSave ?? false),
    bindRepoCredential:
      opts.bindRepoCredential ??
      (async (repoId, binding) => {
        bindCalls.push({ repoId, ...binding });
      }),
    getRepo: opts.getRepo ?? (async () => ({ owner: 'acme', name: 'omadia' })),
    publicBaseUrl: 'https://ops.example.com',
    githubBaseUrl: 'https://github.com',
    githubApiBaseUrl: 'https://api.github.com',
    fetchImpl: (opts.fetchImpl ?? (async () => jsonResponse(404, {}))) as unknown as typeof fetch,
    ...(opts.recheckBranchProtection ? { recheckBranchProtection: opts.recheckBranchProtection } : {}),
  };

  const routers = createDevPlatformGithubAppRouter(deps);
  const inject: RequestHandler = (req, _res, next) => {
    const sub = req.header('x-test-sub');
    if (sub) (req as unknown as { session: { sub: string } }).session = { sub };
    next();
  };
  const app = express();
  app.use(inject);
  app.use('/api/v1/admin/dev-platform', routers.admin);
  app.use('/bot-api/v1/dev-platform', routers.public);
  const server = app.listen(0);
  await new Promise<void>((r) => server.once('listening', r));
  const port = String((server.address() as AddressInfo).port);
  return {
    state,
    flowStore,
    bindCalls,
    admin: `http://127.0.0.1:${port}/api/v1/admin/dev-platform`,
    bot: `http://127.0.0.1:${port}/bot-api/v1/dev-platform`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

const authed = (sub: string): Record<string, string> => ({ 'x-test-sub': sub, 'content-type': 'application/json' });

// ---------------------------------------------------------------------------

describe('devPlatformGithubApp — manifest/start (admin)', () => {
  it('returns the exact permission set + action URL and records a pending flow', async () => {
    const h = await harness();
    after(() => h.close());
    const res = await fetch(`${h.admin}/github-app/manifest/start`, {
      method: 'POST',
      headers: authed('user-1'),
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { action: string; manifest: Record<string, unknown> };
    assert.deepEqual(body.manifest['default_permissions'], {
      contents: 'write',
      pull_requests: 'write',
      issues: 'write',
      metadata: 'read',
    });
    assert.deepEqual(body.manifest['default_events'], ['issues']);
    assert.equal((body.manifest['hook_attributes'] as { active: boolean }).active, false);
    assert.match(body.action, /^https:\/\/github\.com\/settings\/apps\/new\?state=/);
    assert.equal(h.flowStore.size(), 1, 'a pending flow was recorded');
  });

  it('org variant targets the org settings path', async () => {
    const h = await harness();
    after(() => h.close());
    const res = await fetch(`${h.admin}/github-app/manifest/start`, {
      method: 'POST',
      headers: authed('user-1'),
      body: JSON.stringify({ org: 'acme' }),
    });
    const body = (await res.json()) as { action: string };
    assert.match(body.action, /\/organizations\/acme\/settings\/apps\/new\?state=/);
  });

  it('401s without a session', async () => {
    const h = await harness();
    after(() => h.close());
    const res = await fetch(`${h.admin}/github-app/manifest/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 401);
  });
});

describe('devPlatformGithubApp — GET /github-apps (admin)', () => {
  it('lists apps with no secret material', async () => {
    const h = await harness({ seedApp: true });
    after(() => h.close());
    const res = await fetch(`${h.admin}/github-apps`, { headers: authed('user-1') });
    assert.equal(res.status, 200);
    const raw = await res.text();
    for (const forbidden of ['pem', 'private', 'client_secret', 'webhook_secret', FAKE_PEM]) {
      assert.ok(!raw.toLowerCase().includes(forbidden.toLowerCase()), `no ${forbidden} in listing`);
    }
    const body = JSON.parse(raw) as { apps: Array<{ appId: string; slug: string }> };
    assert.equal(body.apps.length, 1);
    assert.equal(body.apps[0]!.appId, '4242');
  });

  it('401s without a session', async () => {
    const h = await harness({ seedApp: true });
    after(() => h.close());
    const res = await fetch(`${h.admin}/github-apps`);
    assert.equal(res.status, 401);
  });
});

describe('devPlatformGithubApp — callback (public /bot-api)', () => {
  const conversion = {
    id: 4242,
    slug: 'omadia-dev',
    owner: { login: 'acme' },
    client_id: 'cid',
    client_secret: 'csecret',
    webhook_secret: 'wsecret',
    pem: FAKE_PEM,
    html_url: 'https://github.com/apps/omadia-dev',
  };

  it('a good state consumes the flow, exchanges, saves, and 302s to the install page', async () => {
    let exchanged = 0;
    const fetchImpl: FetchStub = async (url) => {
      if (url.includes('/app-manifests/')) {
        exchanged += 1;
        return jsonResponse(201, conversion);
      }
      return jsonResponse(404, {});
    };
    const h = await harness({ fetchImpl });
    after(() => h.close());
    const flow = h.flowStore.start({ createdBySub: 'user-1' });

    const res = await fetch(`${h.bot}/github-app/callback?code=abc&state=${flow.state}`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), 'https://github.com/apps/omadia-dev/installations/new');
    assert.equal(exchanged, 1, 'exchange called once');
    assert.equal(h.state.saved.length, 1, 'app saved');
    assert.equal(h.state.saved[0]!.createdBy, 'user-1', 'createdBy carried from the flow');
    assert.equal(h.flowStore.size(), 0, 'flow consumed');
  });

  it('an unknown state → 400 and consumes nothing (no exchange)', async () => {
    let exchanged = 0;
    const fetchImpl: FetchStub = async () => {
      exchanged += 1;
      return jsonResponse(201, conversion);
    };
    const h = await harness({ fetchImpl });
    after(() => h.close());
    h.flowStore.start({ createdBySub: 'user-1' }); // a live, untouched flow

    const res = await fetch(`${h.bot}/github-app/callback?code=abc&state=bogus`, { redirect: 'manual' });
    assert.equal(res.status, 400);
    assert.equal(exchanged, 0, 'no exchange on a bad state');
    assert.equal(h.flowStore.size(), 1, 'the real flow is untouched');
    assert.equal(h.state.saved.length, 0);
  });

  it('a conversion error never leaks the pem', async () => {
    const fetchImpl: FetchStub = async (url) => {
      if (url.includes('/app-manifests/')) {
        // A hostile / error body that still carries a pem field — must not surface.
        return jsonResponse(422, { pem: FAKE_PEM, message: 'nope' });
      }
      return jsonResponse(404, {});
    };
    const h = await harness({ fetchImpl });
    after(() => h.close());
    const flow = h.flowStore.start({ createdBySub: 'user-1' });

    const res = await fetch(`${h.bot}/github-app/callback?code=abc&state=${flow.state}`, { redirect: 'manual' });
    assert.ok(res.status >= 400, 'an error status');
    const text = await res.text();
    assert.ok(!text.includes(FAKE_PEM), 'the pem never appears in the response');
    assert.equal(h.state.saved.length, 0, 'nothing saved on a failed conversion');
  });

  it('a save failure tells the operator to delete the orphan', async () => {
    const fetchImpl: FetchStub = async (url) =>
      url.includes('/app-manifests/') ? jsonResponse(201, conversion) : jsonResponse(404, {});
    const h = await harness({ fetchImpl, failSave: true });
    after(() => h.close());
    const flow = h.flowStore.start({ createdBySub: 'user-1' });
    const res = await fetch(`${h.bot}/github-app/callback?code=abc&state=${flow.state}`, { redirect: 'manual' });
    assert.equal(res.status, 500);
    const text = await res.text();
    assert.match(text, /delete the orphan/i);
    assert.match(text, /omadia-dev/, 'the orphan html_url is surfaced');
    assert.equal(h.state.saved.length, 0);
  });
});

describe('devPlatformGithubApp — setup (public /bot-api)', () => {
  it('verifies the installation belongs to a known App, upserts, and 302s to admin', async () => {
    const fetchImpl: FetchStub = async (url) => {
      if (url.includes('/app/installations/777')) {
        return jsonResponse(200, { id: 777, account: { login: 'acme' } });
      }
      return jsonResponse(404, {});
    };
    const h = await harness({ seedApp: true, fetchImpl });
    after(() => h.close());
    const res = await fetch(`${h.bot}/github-app/setup?installation_id=777&setup_action=install`, {
      redirect: 'manual',
    });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), 'https://ops.example.com/admin/dev-platform?installed=777');
    assert.equal(h.state.upserts.length, 1);
    assert.deepEqual(h.state.upserts[0], { appRowId: 'row-1', installationId: '777', accountLogin: 'acme' });
  });

  it('400s when no App claims the installation', async () => {
    const fetchImpl: FetchStub = async () => jsonResponse(404, {}); // GitHub denies every App
    const h = await harness({ seedApp: true, fetchImpl });
    after(() => h.close());
    const res = await fetch(`${h.bot}/github-app/setup?installation_id=999`, { redirect: 'manual' });
    assert.equal(res.status, 400);
    assert.equal(h.state.upserts.length, 0);
  });
});

describe('devPlatformGithubApp — repo credential binding (admin)', () => {
  it('binds when the installation covers the repo', async () => {
    const fetchImpl: FetchStub = async (url) => {
      if (url.endsWith('/repos/acme/omadia/installation')) {
        return jsonResponse(200, { id: 777 });
      }
      return jsonResponse(404, {});
    };
    const h = await harness({ seedApp: true, fetchImpl, recheckBranchProtection: async () => ['default branch unprotected'] });
    after(() => h.close());
    // Register the installation (as the setup callback would).
    h.state.installations.set('777', { id: 'inst-777', appRowId: 'row-1', installationId: '777', accountLogin: 'acme' });

    const res = await fetch(`${h.admin}/repos/repo-1/credential`, {
      method: 'POST',
      headers: authed('user-1'),
      body: JSON.stringify({ kind: 'github_app', installationId: '777' }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; warnings: string[] };
    assert.equal(body.ok, true);
    assert.deepEqual(body.warnings, ['default branch unprotected']);
    assert.equal(h.bindCalls.length, 1);
    assert.deepEqual(h.bindCalls[0], { repoId: 'repo-1', appRowId: 'row-1', installationId: '777' });
  });

  it('400s when the installation does NOT cover the repo', async () => {
    const fetchImpl: FetchStub = async (url) => {
      // Repo is covered by a DIFFERENT installation than the one being bound.
      if (url.endsWith('/repos/acme/omadia/installation')) return jsonResponse(200, { id: 555 });
      return jsonResponse(404, {});
    };
    const h = await harness({ seedApp: true, fetchImpl });
    after(() => h.close());
    h.state.installations.set('777', { id: 'inst-777', appRowId: 'row-1', installationId: '777', accountLogin: 'acme' });

    const res = await fetch(`${h.admin}/repos/repo-1/credential`, {
      method: 'POST',
      headers: authed('user-1'),
      body: JSON.stringify({ kind: 'github_app', installationId: '777' }),
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json() as { code: string }).code, 'devplatform.installation_not_covering');
    assert.equal(h.bindCalls.length, 0, 'nothing bound on a coverage miss');
  });

  it('401s without a session', async () => {
    const h = await harness({ seedApp: true });
    after(() => h.close());
    const res = await fetch(`${h.admin}/repos/repo-1/credential`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'github_app', installationId: '777' }),
    });
    assert.equal(res.status, 401);
  });
});
