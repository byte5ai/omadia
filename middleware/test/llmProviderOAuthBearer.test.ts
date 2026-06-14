import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  OPENAI_CODEX_OAUTH,
  providerOAuthVaultKeys,
  resolveProviderOAuthBearer,
  writeProviderOAuthTokens,
  type FetchLike,
} from '@omadia/llm-provider';

/**
 * Phase 4b — OAuth bearer resolution (the wiring that feeds resolveLlmProvider).
 * Pure + mocked: returns a usable access token, auto-refreshing + persisting an
 * expired one, and falling back to undefined (→ api_key path) when no OAuth
 * tokens are stored.
 */

const NOW = 2_000_000;
const now = (): number => NOW;

function fakeVault(): {
  get: (k: string) => Promise<string | undefined>;
  set: (k: string, v: string) => Promise<void>;
  store: Map<string, string>;
} {
  const store = new Map<string, string>();
  return {
    store,
    get: (k) => Promise.resolve(store.get(k)),
    set: (k, v) => {
      store.set(k, v);
      return Promise.resolve();
    },
  };
}

const neverFetch: FetchLike = () => {
  throw new Error('fetch must not be called');
};

describe('resolveProviderOAuthBearer', () => {
  it('returns undefined when the provider has no OAuth tokens (→ api_key path)', async () => {
    const v = fakeVault();
    const bearer = await resolveProviderOAuthBearer({
      get: v.get,
      set: v.set,
      providerId: 'openai',
      fetchImpl: neverFetch,
      config: OPENAI_CODEX_OAUTH,
      nowMs: now,
    });
    assert.equal(bearer, undefined);
  });

  it('returns the access token unchanged when it is still valid (no refresh)', async () => {
    const v = fakeVault();
    await writeProviderOAuthTokens(v.set, 'openai', {
      accessToken: 'AT-valid',
      refreshToken: 'RT-1',
      expiresAt: NOW + 600_000, // well in the future
    });
    const bearer = await resolveProviderOAuthBearer({
      get: v.get,
      set: v.set,
      providerId: 'openai',
      fetchImpl: neverFetch, // must not refresh
      config: OPENAI_CODEX_OAUTH,
      nowMs: now,
    });
    assert.equal(bearer, 'AT-valid');
  });

  it('refreshes + persists an expired token, returning the new access token', async () => {
    const v = fakeVault();
    await writeProviderOAuthTokens(v.set, 'openai', {
      accessToken: 'AT-old',
      refreshToken: 'RT-1',
      expiresAt: NOW - 1, // expired
    });
    let refreshCalls = 0;
    const fetchImpl: FetchLike = (_url, init) => {
      refreshCalls += 1;
      assert.match(init.body, /grant_type=refresh_token/);
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            access_token: 'AT-new',
            refresh_token: 'RT-2',
            expires_in: 3600,
          }),
      });
    };
    const bearer = await resolveProviderOAuthBearer({
      get: v.get,
      set: v.set,
      providerId: 'openai',
      fetchImpl,
      config: OPENAI_CODEX_OAUTH,
      nowMs: now,
    });
    assert.equal(refreshCalls, 1);
    assert.equal(bearer, 'AT-new');
    // rotated tokens persisted back to the vault
    const keys = providerOAuthVaultKeys('openai');
    assert.equal(v.store.get(keys.access), 'AT-new');
    assert.equal(v.store.get(keys.refresh), 'RT-2');
    assert.equal(v.store.get(keys.expiresAt), String(NOW + 3600 * 1000));
  });

  it('returns the (likely-dead) access token when expired with no refresh token', async () => {
    const v = fakeVault();
    await writeProviderOAuthTokens(v.set, 'openai', {
      accessToken: 'AT-stale',
      expiresAt: NOW - 1, // expired, no refresh token
    });
    const bearer = await resolveProviderOAuthBearer({
      get: v.get,
      set: v.set,
      providerId: 'openai',
      fetchImpl: neverFetch, // cannot refresh
      config: OPENAI_CODEX_OAUTH,
      nowMs: now,
    });
    assert.equal(bearer, 'AT-stale');
  });
});
