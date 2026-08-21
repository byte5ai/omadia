/**
 * /api/v1/admin/providers OAuth connect routes (#294) — device-flow start/poll,
 * token fan-out to every LLM scope, reactivation, and the `oauthConnect`/status
 * surfacing on the listing. Injected fetch + config: no live endpoints.
 */
import { describe, it, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  LlmProviderCatalog,
  clearExternalModels,
  providerOAuthVaultKeys,
  type OAuthClientConfig,
  __resetProviderOAuthTokenStore,
} from '@omadia/llm-provider';
import express from 'express';
import type { Express } from 'express';

import { createAdminProvidersRouter } from '../src/routes/adminProviders.js';
import { InMemoryInstalledRegistry } from '../src/plugins/installedRegistry.js';
import { InMemorySecretVault } from '../src/secrets/vault.js';
import { registerBuiltinLlmProviders } from '../src/platform/builtinLlmProviders.js';

const ORCH = '@omadia/orchestrator';
const VERIFIER = '@omadia/verifier';
const EXTRAS = '@omadia/orchestrator-extras';
const PROVIDER = 'openai-chatgpt';
const CFG: OAuthClientConfig = {
  issuer: 'https://issuer.test',
  clientId: 'cid',
  userAgent: 'ua',
};

interface Step {
  ok?: boolean;
  status?: number;
  body: unknown;
}

/** A scripted fetch: each outbound call consumes the next step in the queue. */
function scriptedFetch(steps: Step[]): { fetch: typeof globalThis.fetch; remaining: () => number } {
  const queue = [...steps];
  const fetch: typeof globalThis.fetch = (async () => {
    const step = queue.shift() ?? { body: {} };
    return {
      ok: step.ok ?? (step.status ?? 200) < 400,
      status: step.status ?? 200,
      json: async () => step.body,
      text: async () => JSON.stringify(step.body),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetch, remaining: () => queue.length };
}

async function makeHarness(steps: Step[]) {
  clearExternalModels();
  __resetProviderOAuthTokenStore();
  const vault = new InMemorySecretVault();
  const registry = new InMemoryInstalledRegistry();
  for (const id of [ORCH, VERIFIER, EXTRAS]) {
    await registry.register({
      id,
      installed_version: '0.1.0',
      installed_at: new Date().toISOString(),
      status: 'active',
      config: {},
    });
  }
  const catalog = new LlmProviderCatalog();
  registerBuiltinLlmProviders(catalog, { includeExperimental: true });
  const reactivated: string[] = [];
  const { fetch } = scriptedFetch(steps);
  const app: Express = express();
  app.use(express.json());
  app.use(
    '/api/v1/admin/providers',
    createAdminProvidersRouter({
      installedRegistry: registry,
      vault,
      reactivate: async (id) => {
        reactivated.push(id);
      },
      llmProviderCatalog: catalog,
      oauthConfig: CFG,
      oauthFetch: fetch,
    }),
  );
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${String(port)}`,
    vault,
    reactivated,
    async close() {
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

let harness: Awaited<ReturnType<typeof makeHarness>> | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
  __resetProviderOAuthTokenStore();
});

describe('POST /oauth/start', () => {
  it('returns a user code + verification URL and never leaks the poll secret', async () => {
    harness = await makeHarness([
      { body: { device_auth_id: 'dev-1', user_code: 'WXYZ-9', interval: 5 } },
    ]);
    const res = await fetch(`${harness.baseUrl}/api/v1/admin/providers/oauth/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: PROVIDER }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body['userCode'], 'WXYZ-9');
    assert.equal(body['verificationUri'], 'https://issuer.test/codex/device');
    assert.ok(typeof body['flowId'] === 'string' && body['flowId'].length > 0);
    // The device_auth_id (poll secret) must not be in the response.
    assert.equal(JSON.stringify(body).includes('dev-1'), false);
  });

  it('rejects a provider that does not declare OAuth', async () => {
    harness = await makeHarness([]);
    const res = await fetch(`${harness.baseUrl}/api/v1/admin/providers/oauth/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'anthropic' }),
    });
    assert.equal(res.status, 400);
  });
});

describe('POST /oauth/poll', () => {
  async function startFlow(): Promise<string> {
    const res = await fetch(`${harness!.baseUrl}/api/v1/admin/providers/oauth/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: PROVIDER }),
    });
    return ((await res.json()) as { flowId: string }).flowId;
  }

  it('surfaces pending, then on approval writes tokens to ALL scopes + reactivates', async () => {
    harness = await makeHarness([
      // start → usercode
      { body: { device_auth_id: 'dev-1', user_code: 'U', interval: 5 } },
      // poll #1 → not approved yet (non-2xx)
      { status: 400, body: {} },
      // poll #2 → approved (authorization code + PKCE)
      { body: { authorization_code: 'auth', code_challenge: 'c', code_verifier: 'v' } },
      // token exchange → tokens
      { body: { access_token: 'at', refresh_token: 'rt', expires_in: 3600 } },
    ]);
    const flowId = await startFlow();

    const pending = await fetch(`${harness.baseUrl}/api/v1/admin/providers/oauth/poll`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ flowId }),
    });
    assert.deepEqual(await pending.json(), { status: 'pending' });

    const done = await fetch(`${harness.baseUrl}/api/v1/admin/providers/oauth/poll`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ flowId }),
    });
    assert.deepEqual(await done.json(), { status: 'complete' });

    // Every LLM scope holds the access token (identical-copies invariant).
    const keys = providerOAuthVaultKeys(PROVIDER);
    for (const scope of [ORCH, VERIFIER, EXTRAS]) {
      assert.equal(await harness.vault.get(scope, keys.access), 'at');
      assert.equal(await harness.vault.get(scope, keys.refresh), 'rt');
      assert.ok(await harness.vault.get(scope, keys.updatedAt));
    }
    // All three installed plugins reactivated.
    assert.deepEqual([...harness.reactivated].sort(), [EXTRAS, ORCH, VERIFIER].sort());
  });

  it('a stale/unknown flowId is expired', async () => {
    harness = await makeHarness([]);
    const res = await fetch(`${harness.baseUrl}/api/v1/admin/providers/oauth/poll`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ flowId: 'nope' }),
    });
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { status: 'expired' });
  });
});

describe('GET / (listing)', () => {
  it('marks the ChatGPT provider oauthConnect and no_key until connected', async () => {
    harness = await makeHarness([]);
    const res = await fetch(`${harness.baseUrl}/api/v1/admin/providers`);
    const body = (await res.json()) as {
      providers: Array<{ id: string; oauthConnect?: boolean; status: string; subscriptionNotice?: boolean }>;
    };
    const row = body.providers.find((p) => p.id === PROVIDER);
    assert.ok(row, 'openai-chatgpt should be listed when experimental is on');
    assert.equal(row.oauthConnect, true);
    assert.equal(row.status, 'no_key');
    assert.equal(row.subscriptionNotice, true);
  });
});
