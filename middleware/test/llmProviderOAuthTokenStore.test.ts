/**
 * Process-wide OAuth token store (#294) — single-flight refresh, rotation
 * persisted before callers resolve, newest-wins hydration across divergent
 * vault scopes, and the terminal reconnect-required latch.
 */
import { describe, it, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  getProviderOAuthBearer,
  isProviderOAuthReconnectRequired,
  registerProviderOAuthStoreBinding,
  __resetProviderOAuthTokenStore,
  type FetchLike,
  type OAuthTokens,
} from '@omadia/llm-provider';

const PROVIDER = 'openai-chatgpt';
const CFG = { issuer: 'https://issuer', clientId: 'cid', userAgent: 'ua' };

/** A refresh-only fetch double: every call returns a fresh rotated token. */
function refreshFetch(
  onCall: () => { status?: number; body: unknown },
): { fetch: FetchLike; count: () => number } {
  let n = 0;
  const fetch: FetchLike = async () => {
    n += 1;
    const r = onCall();
    return {
      ok: (r.status ?? 200) < 400,
      status: r.status ?? 200,
      json: async () => r.body,
      text: async () => JSON.stringify(r.body),
    } as Awaited<ReturnType<FetchLike>>;
  };
  return { fetch, count: () => n };
}

afterEach(() => __resetProviderOAuthTokenStore());

describe('providerOAuthTokenStore', () => {
  it('single-flights concurrent refreshes into ONE token-endpoint call', async () => {
    const stale: OAuthTokens = { accessToken: 'old', refreshToken: 'r0', expiresAt: 0 };
    const persisted: OAuthTokens[] = [];
    const { fetch, count } = refreshFetch(() => ({
      body: { access_token: 'new', refresh_token: 'r1', expires_in: 3600 },
    }));
    registerProviderOAuthStoreBinding(PROVIDER, {
      load: async () => [{ tokens: stale, updatedAt: 1 }],
      persist: async (t) => {
        persisted.push(t);
      },
    });

    const deps = { fetchImpl: fetch, config: CFG, nowMs: () => 1_000_000 };
    const results = await Promise.all([
      getProviderOAuthBearer(PROVIDER, deps),
      getProviderOAuthBearer(PROVIDER, deps),
      getProviderOAuthBearer(PROVIDER, deps),
    ]);
    assert.deepEqual(results, ['new', 'new', 'new']);
    assert.equal(count(), 1); // single-flight: one refresh for three callers
    assert.equal(persisted.length, 1); // rotation persisted once, before resolve
    assert.equal(persisted[0]?.refreshToken, 'r1');
  });

  it('hydrates newest-wins across divergent scope copies', async () => {
    // An older scope still holds a pre-rotation refresh token; the store must
    // pick the NEWER copy (higher updatedAt), not resurrect the stale one.
    const older: OAuthTokens = { accessToken: 'a-old', refreshToken: 'stale', expiresAt: 10 ** 15 };
    const newer: OAuthTokens = { accessToken: 'a-new', refreshToken: 'fresh', expiresAt: 10 ** 15 };
    registerProviderOAuthStoreBinding(PROVIDER, {
      load: async () => [
        { tokens: older, updatedAt: 100 },
        { tokens: newer, updatedAt: 200 },
      ],
      persist: async () => undefined,
    });
    // Access token is far from expiry → no refresh, just hydration.
    const bearer = await getProviderOAuthBearer(PROVIDER, {
      config: CFG,
      nowMs: () => 1,
    });
    assert.equal(bearer, 'a-new');
  });

  it('latches reconnect_required on a terminal refresh error and stops retrying', async () => {
    const stale: OAuthTokens = { accessToken: 'old', refreshToken: 'dead', expiresAt: 0 };
    const { fetch, count } = refreshFetch(() => ({
      status: 400,
      body: { error: { code: 'refresh_token_reused' } },
    }));
    registerProviderOAuthStoreBinding(PROVIDER, {
      load: async () => [{ tokens: stale, updatedAt: 1 }],
      persist: async () => undefined,
    });
    const deps = { fetchImpl: fetch, config: CFG, nowMs: () => 1_000_000 };

    await assert.rejects(() => getProviderOAuthBearer(PROVIDER, deps));
    assert.equal(isProviderOAuthReconnectRequired(PROVIDER), true);
    // A second call fails fast from the cached latch — no new endpoint hit.
    await assert.rejects(() => getProviderOAuthBearer(PROVIDER, deps));
    assert.equal(count(), 1);
  });

  it('keeps the refreshed token in memory even when persistence throws', async () => {
    // The old refresh token is already dead server-side; a transient vault
    // failure must NOT drop the rotated token (which would wedge the grant).
    const stale: OAuthTokens = { accessToken: 'old', refreshToken: 'r0', expiresAt: 0 };
    const { fetch } = refreshFetch(() => ({
      body: { access_token: 'new', refresh_token: 'r1', expires_in: 3600 },
    }));
    registerProviderOAuthStoreBinding(PROVIDER, {
      load: async () => [{ tokens: stale, updatedAt: 1 }],
      persist: async () => {
        throw new Error('vault down');
      },
    });
    const deps = { fetchImpl: fetch, config: CFG, nowMs: () => 1_000_000, log: () => undefined };

    const bearer = await getProviderOAuthBearer(PROVIDER, deps);
    assert.equal(bearer, 'new'); // rotation kept despite persist failure
    assert.equal(isProviderOAuthReconnectRequired(PROVIDER), false);
    // A second call reuses the in-memory rotated token — no reuse of r0.
    const again = await getProviderOAuthBearer(PROVIDER, {
      config: CFG,
      nowMs: () => 1_000_001,
    });
    assert.equal(again, 'new');
  });

  it('does not throw "no tokens stored" for a second caller during a slow hydration', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const valid: OAuthTokens = { accessToken: 'v', refreshToken: 'r', expiresAt: 10 ** 15 };
    registerProviderOAuthStoreBinding(PROVIDER, {
      load: async () => {
        await gate; // hydration spans many ticks, like the real vault binding
        return [{ tokens: valid, updatedAt: 1 }];
      },
      persist: async () => undefined,
    });
    const deps = { config: CFG, nowMs: () => 1 };
    const p1 = getProviderOAuthBearer(PROVIDER, deps);
    const p2 = getProviderOAuthBearer(PROVIDER, deps);
    release();
    assert.deepEqual(await Promise.all([p1, p2]), ['v', 'v']);
  });

  it('serves a still-valid access token without any refresh', async () => {
    const fresh: OAuthTokens = { accessToken: 'valid', refreshToken: 'r', expiresAt: 10 ** 15 };
    const { fetch, count } = refreshFetch(() => ({ body: {} }));
    registerProviderOAuthStoreBinding(PROVIDER, {
      load: async () => [{ tokens: fresh, updatedAt: 1 }],
      persist: async () => undefined,
    });
    const bearer = await getProviderOAuthBearer(PROVIDER, {
      fetchImpl: fetch,
      config: CFG,
      nowMs: () => 1,
    });
    assert.equal(bearer, 'valid');
    assert.equal(count(), 0);
  });
});
