import { strict as assert } from 'node:assert';
import { afterEach, describe, it } from 'node:test';

import { OAuthClient } from '../../src/auth/oauthClient.js';
import { EntraProvider } from '../../src/auth/providers/EntraProvider.js';
import { RefreshStore } from '../../src/auth/refreshStore.js';
import { EmailWhitelist } from '../../src/auth/whitelist.js';
import type { SecretVault } from '../../src/secrets/vault.js';

/**
 * #965 — `EntraProvider.revalidateSession`, the IdP re-check behind
 * `POST /api/v1/auth/renew`. The token endpoint is stubbed via
 * `globalThis.fetch`; the vault is in-memory. Renewal fails closed, but a
 * definite denial (400/401) must be told apart from an outage (5xx, 429,
 * network error) so the UI can offer a retry for the latter only.
 */

const EMAIL = 'entra@example.com';
const OID = 'aad-oid-1';

class InMemoryVault implements SecretVault {
  private readonly store = new Map<string, string>();
  async set(agentId: string, key: string, value: string): Promise<void> {
    this.store.set(`${agentId}/${key}`, value);
  }
  async setMany(agentId: string, entries: Record<string, string>): Promise<void> {
    for (const [k, v] of Object.entries(entries)) this.store.set(`${agentId}/${k}`, v);
  }
  async get(agentId: string, key: string): Promise<string | undefined> {
    return this.store.get(`${agentId}/${key}`);
  }
  async listKeys(): Promise<string[]> {
    return [];
  }
  async purge(): Promise<void> {
    this.store.clear();
  }
  async deleteKey(agentId: string, key: string): Promise<void> {
    this.store.delete(`${agentId}/${key}`);
  }
}

function idToken(claims: Record<string, unknown>): string {
  const enc = (v: unknown): string => Buffer.from(JSON.stringify(v)).toString('base64url');
  return `${enc({ alg: 'none' })}.${enc(claims)}.sig`;
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function stubTokenEndpoint(respond: () => Response | Promise<Response>): void {
  globalThis.fetch = (async () => respond()) as typeof fetch;
}

function tokenResponse(claims: Record<string, unknown>, refreshToken = 'rt-rotated'): Response {
  return new Response(
    JSON.stringify({
      access_token: 'at',
      id_token: idToken(claims),
      refresh_token: refreshToken,
      expires_in: 3600,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

async function setup(opts: { storedToken?: string; whitelist?: string } = {}): Promise<{
  provider: EntraProvider;
  refreshStore: RefreshStore;
}> {
  const refreshStore = new RefreshStore(new InMemoryVault());
  if (opts.storedToken !== undefined) await refreshStore.save(EMAIL, opts.storedToken);
  const provider = new EntraProvider({
    oauth: new OAuthClient({
      tenantId: 'tenant',
      clientId: 'client',
      clientSecret: 'secret',
      redirectUri: 'http://localhost/cb',
    }),
    refreshStore,
    whitelist: new EmailWhitelist(opts.whitelist ?? EMAIL),
  });
  return { provider, refreshStore };
}

const INPUT = { email: EMAIL, providerUserId: OID };

describe('EntraProvider.revalidateSession (#965)', () => {
  it('denies when no refresh token is on file (e.g. after logout)', async () => {
    let called = false;
    stubTokenEndpoint(() => {
      called = true;
      return new Response('', { status: 500 });
    });
    const { provider } = await setup();
    assert.equal((await provider.revalidateSession(INPUT)).outcome, 'denied');
    assert.equal(called, false, 'no IdP round trip without a token');

    const forgotten = await setup({ storedToken: '' });
    assert.equal((await forgotten.provider.revalidateSession(INPUT)).outcome, 'denied');
  });

  it('denies on 400 invalid_grant and forgets the dead token', async () => {
    stubTokenEndpoint(
      () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }),
    );
    const { provider, refreshStore } = await setup({ storedToken: 'rt-old' });
    assert.equal((await provider.revalidateSession(INPUT)).outcome, 'denied');
    assert.equal(await refreshStore.get(EMAIL), '', 'the rejected token is forgotten');
  });

  for (const status of [503, 429]) {
    it(`reports unavailable on HTTP ${String(status)} and keeps the token`, async () => {
      stubTokenEndpoint(() => new Response('busy', { status }));
      const { provider, refreshStore } = await setup({ storedToken: 'rt-old' });
      assert.equal((await provider.revalidateSession(INPUT)).outcome, 'unavailable');
      assert.equal(await refreshStore.get(EMAIL), 'rt-old');
    });
  }

  it('reports unavailable when the IdP cannot be reached', async () => {
    stubTokenEndpoint(() => Promise.reject(new TypeError('fetch failed')));
    const { provider } = await setup({ storedToken: 'rt-old' });
    assert.equal((await provider.revalidateSession(INPUT)).outcome, 'unavailable');
  });

  it('returns ok for the same identity and stores the rotated refresh token', async () => {
    stubTokenEndpoint(() => tokenResponse({ oid: OID, tid: 't', email: EMAIL }));
    const { provider, refreshStore } = await setup({ storedToken: 'rt-old' });
    assert.deepEqual(await provider.revalidateSession(INPUT), { outcome: 'ok' });
    assert.equal(await refreshStore.get(EMAIL), 'rt-rotated');
  });

  it('denies an id_token for another oid or another email', async () => {
    stubTokenEndpoint(() => tokenResponse({ oid: 'someone-else', tid: 't', email: EMAIL }));
    const a = await setup({ storedToken: 'rt-old' });
    assert.equal((await a.provider.revalidateSession(INPUT)).outcome, 'denied');

    stubTokenEndpoint(() => tokenResponse({ oid: OID, tid: 't', email: 'other@example.com' }));
    const b = await setup({ storedToken: 'rt-old' });
    assert.equal((await b.provider.revalidateSession(INPUT)).outcome, 'denied');
  });

  it('denies an email that has left the whitelist', async () => {
    stubTokenEndpoint(() => tokenResponse({ oid: OID, tid: 't', email: EMAIL }));
    const { provider } = await setup({ storedToken: 'rt-old', whitelist: 'someone@example.com' });
    assert.equal((await provider.revalidateSession(INPUT)).outcome, 'denied');
  });
});
