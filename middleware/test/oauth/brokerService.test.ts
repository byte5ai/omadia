/**
 * Spec 005 T24/T27 — the kernel OAuth broker, end-to-end against a stub IdP
 * (no network). Exercises start → authorize redirect, callback → code
 * exchange + token persistence, single-use replay protection, user-deny, bad
 * state, and the missing-credential guards. Uses a real catalog plugin (built
 * via adaptManifestV1) so the descriptor + oauth-field parsing is on the path.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { adaptManifestV1 } from '../../src/plugins/manifestLoader.js';
import type { PluginCatalog } from '../../src/plugins/manifestLoader.js';
import type { InstalledRegistry } from '../../src/plugins/installedRegistry.js';
import type { SecretVault } from '../../src/secrets/vault.js';
import {
  OAuthBrokerService,
  OAuthBrokerError,
  PendingFlowStore,
  verifyOAuthState,
  readStoredTokens,
} from '../../src/plugins/oauth/index.js';

const PLUGIN_ID = '@omadia/integration-atlassian';

const plugin = adaptManifestV1({
  schema_version: '1',
  identity: {
    id: PLUGIN_ID,
    kind: 'integration',
    domain: 'atlassian',
    name: 'Atlassian',
    version: '0.1.0',
  },
  setup: {
    fields: [
      { key: 'client_id', type: 'string', label: 'Client ID' },
      { key: 'client_secret', type: 'secret', label: 'Client Secret' },
      {
        key: 'connection',
        type: 'oauth',
        label: 'Connect',
        provider: 'atlassian',
        scopes: ['read:jira-work', 'offline_access'],
      },
    ],
  },
  oauth_providers: [
    {
      id: 'atlassian',
      authorize_url: 'https://auth.atlassian.com/authorize',
      token_url: 'https://auth.atlassian.com/oauth/token',
      token_auth_style: 'body_json',
      extra_authorize_params: { audience: 'api.atlassian.com', prompt: 'consent' },
      client_id_field: 'client_id',
      client_secret_field: 'client_secret',
    },
  ],
})!;

class FakeVault {
  readonly store = new Map<string, string>();
  async get(agentId: string, key: string): Promise<string | undefined> {
    return this.store.get(`${agentId}::${key}`);
  }
  async set(agentId: string, key: string, value: string): Promise<void> {
    this.store.set(`${agentId}::${key}`, value);
  }
  async setMany(agentId: string, entries: Record<string, string>): Promise<void> {
    for (const [k, v] of Object.entries(entries)) await this.set(agentId, k, v);
  }
  async purge(agentId: string): Promise<void> {
    for (const k of [...this.store.keys()]) {
      if (k.startsWith(`${agentId}::`)) this.store.delete(k);
    }
  }
}

interface Harness {
  broker: OAuthBrokerService;
  vault: FakeVault;
  signingKey: Uint8Array;
  pendingFlows: PendingFlowStore;
  lastExchangeBody: () => string;
  reactivatedWith: () => string[];
}

function makeHarness(opts: {
  config?: Record<string, unknown>;
  seedSecret?: boolean;
  tokenStatus?: number;
} = {}): Harness {
  const config = opts.config ?? { client_id: 'atl-client' };
  const vault = new FakeVault();
  if (opts.seedSecret !== false) {
    vault.store.set(`${PLUGIN_ID}::client_secret`, 'atl-secret');
  }
  const catalog = {
    get: (id: string) => (id === PLUGIN_ID ? { plugin } : undefined),
  } as unknown as PluginCatalog;
  const registry = {
    get: (id: string) => (id === PLUGIN_ID ? { id: PLUGIN_ID, config } : undefined),
  } as unknown as InstalledRegistry;
  const signingKey = new Uint8Array(crypto.randomBytes(64));
  const pendingFlows = new PendingFlowStore();
  let lastBody = '';
  const fetchImpl: typeof fetch = async (_url, init) => {
    lastBody = String((init as { body?: BodyInit }).body);
    return new Response(
      JSON.stringify({
        access_token: 'AT',
        refresh_token: 'RT',
        expires_in: 3600,
        scope: 'read:jira-work offline_access',
      }),
      { status: opts.tokenStatus ?? 200 },
    );
  };
  const reactivated: string[] = [];
  const broker = new OAuthBrokerService({
    catalog,
    registry,
    vault: vault as unknown as SecretVault,
    pendingFlows,
    signingKey,
    publicBaseUrl: 'https://app.example',
    reactivatePlugin: async (id: string) => {
      reactivated.push(id);
    },
    fetchImpl,
    now: () => Date.parse('2026-06-16T12:00:00.000Z'),
  });
  return {
    broker,
    vault,
    signingKey,
    pendingFlows,
    lastExchangeBody: () => lastBody,
    reactivatedWith: () => reactivated,
  };
}

async function startAndExtractState(h: Harness): Promise<string> {
  const { redirectUrl } = await h.broker.start({
    pluginId: PLUGIN_ID,
    fieldKey: 'connection',
  });
  const state = new URL(redirectUrl).searchParams.get('state');
  assert.ok(state, 'authorize URL must carry a state param');
  return state;
}

test('start: builds the authorize redirect with a verifiable, plugin-bound state', async () => {
  const h = makeHarness();
  try {
    const { redirectUrl } = await h.broker.start({
      pluginId: PLUGIN_ID,
      fieldKey: 'connection',
    });
    const url = new URL(redirectUrl);
    assert.equal(url.origin + url.pathname, 'https://auth.atlassian.com/authorize');
    assert.equal(url.searchParams.get('client_id'), 'atl-client');
    assert.equal(url.searchParams.get('audience'), 'api.atlassian.com');
    assert.equal(url.searchParams.get('scope'), 'read:jira-work offline_access');
    assert.ok(url.searchParams.get('code_challenge'), 'PKCE challenge present');
    assert.equal(
      url.searchParams.get('redirect_uri'),
      'https://app.example/bot-api/v1/install/oauth/callback',
    );
    const claims = await verifyOAuthState(
      url.searchParams.get('state')!,
      h.signingKey,
    );
    assert.equal(claims.pluginId, PLUGIN_ID);
    assert.equal(claims.providerId, 'atlassian');
    assert.equal(claims.fieldKey, 'connection');
    assert.equal(h.pendingFlows.size(), 1);
  } finally {
    h.pendingFlows.clear();
  }
});

test('callback: exchanges the code, persists tokens, redirects connected=ok', async () => {
  const h = makeHarness();
  try {
    const state = await startAndExtractState(h);
    const { redirectUrl } = await h.broker.callback({ state, code: 'auth-code' });
    assert.equal(
      redirectUrl,
      `https://app.example/store/${encodeURIComponent(PLUGIN_ID)}?connected=ok`,
    );
    // PKCE verifier threaded into the JSON exchange body.
    const body = JSON.parse(h.lastExchangeBody()) as Record<string, string>;
    assert.equal(body['grant_type'], 'authorization_code');
    assert.ok(body['code_verifier'], 'verifier present in exchange');
    const tokens = await readStoredTokens(
      h.vault as unknown as SecretVault,
      PLUGIN_ID,
      'connection',
    );
    assert.equal(tokens?.accessToken, 'AT');
    assert.equal(tokens?.refreshToken, 'RT');
    assert.equal(tokens?.expiresAt, '2026-06-16T13:00:00.000Z');
    assert.equal(h.pendingFlows.size(), 0, 'flow consumed');
    assert.deepEqual(
      h.reactivatedWith(),
      [PLUGIN_ID],
      'plugin re-activated once so its status/derived-config refresh',
    );
  } finally {
    h.pendingFlows.clear();
  }
});

test('callback: user-deny stores nothing and redirects with the error reason', async () => {
  const h = makeHarness();
  try {
    const state = await startAndExtractState(h);
    const { redirectUrl } = await h.broker.callback({
      state,
      error: 'access_denied',
    });
    assert.match(redirectUrl, /connected=error&reason=access_denied$/);
    const tokens = await readStoredTokens(
      h.vault as unknown as SecretVault,
      PLUGIN_ID,
      'connection',
    );
    assert.equal(tokens, undefined);
    assert.deepEqual(h.reactivatedWith(), [], 'no reactivation on deny');
  } finally {
    h.pendingFlows.clear();
  }
});

test('callback: a tampered/garbage state lands on the store list with bad_state', async () => {
  const h = makeHarness();
  const { redirectUrl } = await h.broker.callback({
    state: 'not-a-real-jwt',
    code: 'x',
  });
  assert.equal(redirectUrl, 'https://app.example/store?connected=error&reason=bad_state');
});

test('callback: replay of a consumed flow is rejected (single-use)', async () => {
  const h = makeHarness();
  try {
    const state = await startAndExtractState(h);
    await h.broker.callback({ state, code: 'auth-code' }); // consumes the flow
    const replay = await h.broker.callback({ state, code: 'auth-code' });
    assert.match(replay.redirectUrl, /connected=error&reason=expired$/);
  } finally {
    h.pendingFlows.clear();
  }
});

test('callback: a failed token exchange redirects connected=error, stores nothing', async () => {
  const h = makeHarness({ tokenStatus: 400 });
  try {
    const state = await startAndExtractState(h);
    const { redirectUrl } = await h.broker.callback({ state, code: 'auth-code' });
    assert.match(redirectUrl, /connected=error&reason=exchange_failed$/);
    const tokens = await readStoredTokens(
      h.vault as unknown as SecretVault,
      PLUGIN_ID,
      'connection',
    );
    assert.equal(tokens, undefined);
  } finally {
    h.pendingFlows.clear();
  }
});

test('start: missing client_secret throws OAuthBrokerError (409)', async () => {
  const h = makeHarness({ seedSecret: false });
  await assert.rejects(
    () => h.broker.start({ pluginId: PLUGIN_ID, fieldKey: 'connection' }),
    (err: unknown) =>
      err instanceof OAuthBrokerError &&
      err.code === 'oauth.client_secret_missing' &&
      err.status === 409,
  );
});

test('start: missing client_id throws OAuthBrokerError (409)', async () => {
  const h = makeHarness({ config: {} });
  await assert.rejects(
    () => h.broker.start({ pluginId: PLUGIN_ID, fieldKey: 'connection' }),
    (err: unknown) =>
      err instanceof OAuthBrokerError && err.code === 'oauth.client_id_missing',
  );
});

test('start: unknown field throws OAuthBrokerError (404)', async () => {
  const h = makeHarness();
  await assert.rejects(
    () => h.broker.start({ pluginId: PLUGIN_ID, fieldKey: 'nope' }),
    (err: unknown) =>
      err instanceof OAuthBrokerError &&
      err.code === 'oauth.field_not_found' &&
      err.status === 404,
  );
});
