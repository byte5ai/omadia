/**
 * Spec 005 T25 — the `ctx.oauthTokens` lazy-refresh accessor.
 *
 * Gating (present iff a `type:oauth` field is declared), pass-through of a
 * still-fresh token, lazy refresh within the 5-min margin (rotating the stored
 * refresh token), and the two typed failure modes (`not_connected`,
 * `refresh_failed`). The refresh path stubs global `fetch` — the accessor
 * calls the engine with the default fetch.
 */

import { strict as assert } from 'node:assert';
import { describe, it, beforeEach, afterEach } from 'node:test';

import { OAuthTokenError } from '@omadia/plugin-api';
import { adaptManifestV1 } from '../src/plugins/manifestLoader.js';
import type {
  PluginCatalog,
  PluginCatalogEntry,
} from '../src/plugins/manifestLoader.js';
import { ServiceRegistry } from '../src/platform/serviceRegistry.js';
import { createPluginContext } from '../src/platform/pluginContext.js';
import type { CreatePluginContextOptions } from '../src/platform/pluginContext.js';
import {
  writeStoredTokens,
  readStoredTokens,
} from '../src/plugins/oauth/tokenStore.js';
import type { SecretVault } from '../src/secrets/vault.js';

const ID = '@omadia/integration-atlassian';

function buildPlugin(withOAuth: boolean) {
  const fields: Array<Record<string, unknown>> = [
    { key: 'client_id', type: 'string', label: 'Client ID' },
    { key: 'client_secret', type: 'secret', label: 'Client Secret' },
  ];
  if (withOAuth) {
    fields.push({
      key: 'connection',
      type: 'oauth',
      label: 'Connect',
      provider: 'atlassian',
      scopes: ['read:jira-work', 'offline_access'],
    });
  }
  return adaptManifestV1({
    schema_version: '1',
    identity: { id: ID, kind: 'integration', domain: 'atlassian', name: 'A', version: '0.1.0' },
    setup: { fields },
    ...(withOAuth
      ? {
          oauth_providers: [
            {
              id: 'atlassian',
              authorize_url: 'https://auth.atlassian.com/authorize',
              token_url: 'https://auth.atlassian.com/oauth/token',
              token_auth_style: 'body_json',
              client_id_field: 'client_id',
              client_secret_field: 'client_secret',
            },
          ],
        }
      : {}),
  })!;
}

class FakeVault {
  readonly store = new Map<string, string>();
  async get(agentId: string, key: string): Promise<string | undefined> {
    return this.store.get(`${agentId}::${key}`);
  }
  async set(agentId: string, key: string, value: string): Promise<void> {
    this.store.set(`${agentId}::${key}`, value);
  }
  async setMany(): Promise<void> {}
  async purge(): Promise<void> {}
  async listKeys(): Promise<string[]> {
    return [];
  }
}

function makeCtx(withOAuth: boolean, vault: FakeVault, config: Record<string, unknown>) {
  const plugin = buildPlugin(withOAuth);
  const entry = { plugin } as unknown as PluginCatalogEntry;
  const catalog = {
    list: () => [entry],
    get: (q: string) => (q === ID ? entry : undefined),
  } as unknown as PluginCatalog;
  const registry = {
    has: () => true,
    list: () => [],
    get: (q: string) => (q === ID ? { id: ID, config } : undefined),
  } as unknown as CreatePluginContextOptions['registry'];
  const stub = () => () => {};
  const opts = {
    agentId: ID,
    vault: vault as unknown as SecretVault,
    registry,
    catalog,
    serviceRegistry: new ServiceRegistry(),
    nativeToolRegistry: { register: stub, registerHandler: stub, get: () => undefined } as unknown as CreatePluginContextOptions['nativeToolRegistry'],
    routeRegistry: { register: stub, list: () => [], disposeBySource: () => 0 } as unknown as CreatePluginContextOptions['routeRegistry'],
    jobScheduler: { register: stub, stopForPlugin: () => {} } as unknown as CreatePluginContextOptions['jobScheduler'],
    notificationRouter: { dispatch: () => {}, registerChannel: stub } as unknown as CreatePluginContextOptions['notificationRouter'],
    uiRouteCatalog: { register: stub } as unknown as CreatePluginContextOptions['uiRouteCatalog'],
    logger: () => {},
  } satisfies CreatePluginContextOptions;
  return createPluginContext(opts);
}

const realFetch = globalThis.fetch;
let fetchCalls = 0;
let tokenResponse: Record<string, unknown> = {};
let tokenStatus = 200;

beforeEach(() => {
  fetchCalls = 0;
  tokenStatus = 200;
  tokenResponse = {
    access_token: 'AT-NEW',
    refresh_token: 'RT-ROTATED',
    expires_in: 3600,
    scope: 'read:jira-work offline_access',
  };
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    return new Response(JSON.stringify(tokenResponse), { status: tokenStatus });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

async function seed(vault: FakeVault, tokens: { accessToken: string; refreshToken: string; expiresAt: string; scope?: string }) {
  await vault.set(ID, 'client_secret', 'atl-secret');
  await writeStoredTokens(vault as unknown as SecretVault, ID, 'connection', {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt,
    scope: tokens.scope ?? 'read:jira-work',
  });
}

const FAR_FUTURE = '2099-01-01T00:00:00.000Z';
const PAST = '2000-01-01T00:00:00.000Z';

describe('Spec 005 — ctx.oauthTokens gating', () => {
  it('is undefined when the manifest declares no type:oauth field', () => {
    const ctx = makeCtx(false, new FakeVault(), { client_id: 'atl-client' });
    assert.equal(ctx.oauthTokens, undefined);
  });

  it('is present when a type:oauth field is declared', () => {
    const ctx = makeCtx(true, new FakeVault(), { client_id: 'atl-client' });
    assert.equal(typeof ctx.oauthTokens?.get, 'function');
  });
});

describe('Spec 005 — ctx.oauthTokens.get', () => {
  it('throws not_connected when no token is stored', async () => {
    const ctx = makeCtx(true, new FakeVault(), { client_id: 'atl-client' });
    await assert.rejects(
      () => ctx.oauthTokens!.get('connection'),
      (e: unknown) => e instanceof OAuthTokenError && e.code === 'not_connected',
    );
  });

  it('returns the stored token without refreshing when still fresh', async () => {
    const vault = new FakeVault();
    await seed(vault, { accessToken: 'AT-FRESH', refreshToken: 'RT', expiresAt: FAR_FUTURE });
    const ctx = makeCtx(true, vault, { client_id: 'atl-client' });
    const token = await ctx.oauthTokens!.get('connection');
    assert.equal(token, 'AT-FRESH');
    assert.equal(fetchCalls, 0, 'no refresh for a fresh token');
  });

  it('lazily refreshes an expired token and rotates the stored refresh token', async () => {
    const vault = new FakeVault();
    await seed(vault, { accessToken: 'AT-OLD', refreshToken: 'RT-OLD', expiresAt: PAST });
    const ctx = makeCtx(true, vault, { client_id: 'atl-client' });
    const token = await ctx.oauthTokens!.get('connection');
    assert.equal(token, 'AT-NEW');
    assert.equal(fetchCalls, 1);
    const stored = await readStoredTokens(vault as unknown as SecretVault, ID, 'connection');
    assert.equal(stored?.accessToken, 'AT-NEW');
    assert.equal(stored?.refreshToken, 'RT-ROTATED', 'rotated RT persisted');
  });

  it('keeps the old refresh token when the provider omits a new one', async () => {
    const vault = new FakeVault();
    await seed(vault, { accessToken: 'AT-OLD', refreshToken: 'RT-OLD', expiresAt: PAST });
    tokenResponse = { access_token: 'AT-NEW', expires_in: 3600 }; // no refresh_token
    const ctx = makeCtx(true, vault, { client_id: 'atl-client' });
    await ctx.oauthTokens!.get('connection');
    const stored = await readStoredTokens(vault as unknown as SecretVault, ID, 'connection');
    assert.equal(stored?.refreshToken, 'RT-OLD');
  });

  it('throws refresh_failed when expired with no refresh token', async () => {
    const vault = new FakeVault();
    await seed(vault, { accessToken: 'AT-OLD', refreshToken: '', expiresAt: PAST });
    const ctx = makeCtx(true, vault, { client_id: 'atl-client' });
    await assert.rejects(
      () => ctx.oauthTokens!.get('connection'),
      (e: unknown) => e instanceof OAuthTokenError && e.code === 'refresh_failed',
    );
    assert.equal(fetchCalls, 0);
  });

  it('throws refresh_failed when the refresh request is rejected, leaving tokens intact', async () => {
    const vault = new FakeVault();
    await seed(vault, { accessToken: 'AT-OLD', refreshToken: 'RT-OLD', expiresAt: PAST });
    tokenStatus = 400;
    const ctx = makeCtx(true, vault, { client_id: 'atl-client' });
    await assert.rejects(
      () => ctx.oauthTokens!.get('connection'),
      (e: unknown) => e instanceof OAuthTokenError && e.code === 'refresh_failed',
    );
    const stored = await readStoredTokens(vault as unknown as SecretVault, ID, 'connection');
    assert.equal(stored?.accessToken, 'AT-OLD', 'unchanged on failed refresh');
  });
});
