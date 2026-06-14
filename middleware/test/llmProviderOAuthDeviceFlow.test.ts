import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  OPENAI_CODEX_OAUTH,
  isAccessTokenExpired,
  pollDeviceToken,
  readProviderOAuthTokens,
  refreshAccessToken,
  requestDeviceCode,
  writeProviderOAuthTokens,
  type FetchLike,
  type OAuthTokens,
} from '@omadia/llm-provider';

/**
 * Phase 4b — OAuth device-flow token lifecycle (pure, mocked-HTTP). The live
 * device flow + the ChatGPT-token audience are out of scope here (need a real
 * login); this locks the deterministic logic: request/poll/refresh state
 * mapping, expiry math, and vault round-trip.
 */

const NOW = 1_000_000; // fixed clock
const now = (): number => NOW;

/** A fetch stub that returns a queued (status, body) per call. */
function fetchSeq(
  responses: ReadonlyArray<{ ok: boolean; status: number; body: unknown }>,
): { impl: FetchLike; calls: Array<{ url: string; body: string }> } {
  const calls: Array<{ url: string; body: string }> = [];
  let i = 0;
  const impl: FetchLike = (url, init) => {
    calls.push({ url, body: init.body });
    const r = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return Promise.resolve({
      ok: r.ok,
      status: r.status,
      json: () => Promise.resolve(r.body),
    });
  };
  return { impl, calls };
}

describe('oauth device flow — requestDeviceCode', () => {
  it('parses the device + user codes and defaults interval/expiry', async () => {
    const { impl, calls } = fetchSeq([
      {
        ok: true,
        status: 200,
        body: {
          device_code: 'DEV-123',
          user_code: 'WXYZ-9999',
          verification_uri: 'https://auth.openai.com/codex/device',
          verification_uri_complete: 'https://auth.openai.com/codex/device?c=WXYZ-9999',
          expires_in: 600,
          interval: 5,
        },
      },
    ]);
    const grant = await requestDeviceCode(impl, OPENAI_CODEX_OAUTH);
    assert.equal(grant.deviceCode, 'DEV-123');
    assert.equal(grant.userCode, 'WXYZ-9999');
    assert.equal(grant.verificationUriComplete, 'https://auth.openai.com/codex/device?c=WXYZ-9999');
    assert.equal(grant.interval, 5);
    // sends client_id + scope to the device-authorization endpoint
    assert.equal(calls[0]?.url, OPENAI_CODEX_OAUTH.deviceAuthorizationEndpoint);
    assert.match(calls[0]?.body ?? '', /client_id=app_EMoamEEZ73f0CkXaXp7hrann/);
  });

  it('throws on a non-ok response', async () => {
    const { impl } = fetchSeq([{ ok: false, status: 400, body: { error: 'invalid_client' } }]);
    await assert.rejects(requestDeviceCode(impl, OPENAI_CODEX_OAUTH), /device authorization failed/);
  });
});

describe('oauth device flow — pollDeviceToken', () => {
  it('maps authorization_pending / slow_down / expired_token / access_denied', async () => {
    for (const [error, status] of [
      ['authorization_pending', 'pending'],
      ['slow_down', 'slow_down'],
      ['expired_token', 'expired'],
      ['access_denied', 'denied'],
    ] as const) {
      const { impl } = fetchSeq([{ ok: false, status: 400, body: { error } }]);
      const r = await pollDeviceToken(impl, OPENAI_CODEX_OAUTH, 'DEV-123', now);
      assert.equal(r.status, status);
    }
  });

  it('returns complete tokens with computed absolute expiry', async () => {
    const { impl, calls } = fetchSeq([
      {
        ok: true,
        status: 200,
        body: {
          access_token: 'AT-1',
          refresh_token: 'RT-1',
          expires_in: 3600,
          token_type: 'Bearer',
          id_token: 'ID-1',
        },
      },
    ]);
    const r = await pollDeviceToken(impl, OPENAI_CODEX_OAUTH, 'DEV-123', now);
    assert.equal(r.status, 'complete');
    if (r.status !== 'complete') return;
    assert.equal(r.tokens.accessToken, 'AT-1');
    assert.equal(r.tokens.refreshToken, 'RT-1');
    assert.equal(r.tokens.expiresAt, NOW + 3600 * 1000);
    // device-code grant type on the token endpoint
    assert.match(calls[0]?.body ?? '', /grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code/);
  });

  it('throws on an unexpected error code', async () => {
    const { impl } = fetchSeq([{ ok: false, status: 500, body: { error: 'server_error' } }]);
    await assert.rejects(pollDeviceToken(impl, OPENAI_CODEX_OAUTH, 'DEV-123', now), /token poll failed/);
  });

  it('does not echo raw server error text into the thrown message', async () => {
    const leaked = 'device_code=DEV-123&refresh_token=RT-1';
    const { impl } = fetchSeq([{ ok: false, status: 400, body: { error: leaked } }]);
    await assert.rejects(
      pollDeviceToken(impl, OPENAI_CODEX_OAUTH, 'DEV-123', now),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /token poll failed/);
        assert.doesNotMatch(err.message, /DEV-123/);
        assert.doesNotMatch(err.message, /RT-1/);
        assert.doesNotMatch(err.message, /device_code=|refresh_token=/);
        return true;
      },
    );
  });
});

describe('oauth device flow — refreshAccessToken', () => {
  it('returns rotated tokens when the server rotates the refresh token', async () => {
    const { impl } = fetchSeq([
      { ok: true, status: 200, body: { access_token: 'AT-2', refresh_token: 'RT-2', expires_in: 3600 } },
    ]);
    const t = await refreshAccessToken(impl, OPENAI_CODEX_OAUTH, 'RT-1', now);
    assert.equal(t.accessToken, 'AT-2');
    assert.equal(t.refreshToken, 'RT-2');
    assert.equal(t.expiresAt, NOW + 3600 * 1000);
  });

  it('preserves the existing refresh token when the server does not rotate it', async () => {
    const { impl } = fetchSeq([
      { ok: true, status: 200, body: { access_token: 'AT-2', expires_in: 3600 } },
    ]);
    const t = await refreshAccessToken(impl, OPENAI_CODEX_OAUTH, 'RT-1', now);
    assert.equal(t.accessToken, 'AT-2');
    assert.equal(t.refreshToken, 'RT-1'); // carried over
  });

  it('throws on refresh failure', async () => {
    const { impl } = fetchSeq([{ ok: false, status: 400, body: { error: 'invalid_grant' } }]);
    await assert.rejects(refreshAccessToken(impl, OPENAI_CODEX_OAUTH, 'RT-x', now), /token refresh failed/);
  });
});

describe('oauth device flow — isAccessTokenExpired', () => {
  it('treats missing token as expired', () => {
    assert.equal(isAccessTokenExpired(undefined, NOW), true);
  });
  it('treats a token with no expiry as valid', () => {
    assert.equal(isAccessTokenExpired({ accessToken: 'AT' }, NOW), false);
  });
  it('expires within the default 60s skew', () => {
    assert.equal(isAccessTokenExpired({ accessToken: 'AT', expiresAt: NOW + 30_000 }, NOW), true);
    assert.equal(isAccessTokenExpired({ accessToken: 'AT', expiresAt: NOW + 120_000 }, NOW), false);
  });
});

describe('oauth tokens — vault round-trip', () => {
  it('writes then reads tokens through a vault scope', async () => {
    const store = new Map<string, string>();
    const set = (k: string, v: string): Promise<void> => {
      store.set(k, v);
      return Promise.resolve();
    };
    const get = (k: string): Promise<string | undefined> => Promise.resolve(store.get(k));

    const tokens: OAuthTokens = {
      accessToken: 'AT-1',
      refreshToken: 'RT-1',
      expiresAt: NOW + 3600 * 1000,
    };
    await writeProviderOAuthTokens(set, 'openai', tokens);
    const read = await readProviderOAuthTokens(get, 'openai');
    assert.deepEqual(read, tokens);
  });

  it('returns undefined when no access token is stored', async () => {
    const get = (): Promise<string | undefined> => Promise.resolve(undefined);
    assert.equal(await readProviderOAuthTokens(get, 'openai'), undefined);
  });

  it('clears stale refresh and expiry values when a later write omits them', async () => {
    const store = new Map<string, string>();
    const set = (k: string, v: string): Promise<void> => {
      store.set(k, v);
      return Promise.resolve();
    };
    const get = (k: string): Promise<string | undefined> => Promise.resolve(store.get(k));

    await writeProviderOAuthTokens(set, 'openai', {
      accessToken: 'AT-1',
      refreshToken: 'RT-1',
      expiresAt: NOW + 3600 * 1000,
    });
    await writeProviderOAuthTokens(set, 'openai', {
      accessToken: 'AT-2',
    });

    assert.deepEqual(await readProviderOAuthTokens(get, 'openai'), {
      accessToken: 'AT-2',
    });
  });
});
