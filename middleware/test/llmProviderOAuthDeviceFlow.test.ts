/**
 * "Sign in with ChatGPT" device-flow token lifecycle (#294) — unit tests for
 * the REAL 3-step protocol (verified live 2026-08-21 against auth.openai.com +
 * the open-source codex CLI). No live network: every call takes an injected
 * fetch + clock.
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  OAuthReconnectRequiredError,
  OPENAI_CODEX_OAUTH,
  exchangeAuthorizationCode,
  isAccessTokenExpired,
  jwtExpiryMs,
  pollDeviceToken,
  refreshAccessToken,
  requestUserCode,
  type FetchLike,
} from '@omadia/llm-provider';

/** A programmable fetch double that records the last request. */
function fakeFetch(
  handler: (url: string, init: Parameters<FetchLike>[1]) => {
    ok?: boolean;
    status?: number;
    body: unknown;
  },
): { fetch: FetchLike; calls: Array<{ url: string; init: Parameters<FetchLike>[1] }> } {
  const calls: Array<{ url: string; init: Parameters<FetchLike>[1] }> = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const r = handler(url, init);
    return {
      ok: r.ok ?? true,
      status: r.status ?? 200,
      json: async () => r.body,
      text: async () => JSON.stringify(r.body),
    } as Awaited<ReturnType<FetchLike>>;
  };
  return { fetch, calls };
}

const CFG = OPENAI_CODEX_OAUTH;

describe('requestUserCode (step 1)', () => {
  it('POSTs JSON {client_id} to the usercode endpoint with a UA header', async () => {
    const { fetch, calls } = fakeFetch(() => ({
      body: {
        device_auth_id: 'dev-1',
        user_code: 'ABCD-1234',
        interval: 5,
        expires_at: '2026-08-21T08:00:00Z',
      },
    }));
    const grant = await requestUserCode(fetch, CFG);
    assert.equal(calls[0]?.url, 'https://auth.openai.com/api/accounts/deviceauth/usercode');
    assert.equal(calls[0]?.init.method, 'POST');
    assert.equal(calls[0]?.init.headers['content-type'], 'application/json');
    assert.ok(calls[0]?.init.headers['user-agent']); // Cloudflare needs a real UA
    assert.deepEqual(JSON.parse(calls[0]!.init.body), { client_id: CFG.clientId });
    assert.equal(grant.deviceAuthId, 'dev-1');
    assert.equal(grant.userCode, 'ABCD-1234');
    assert.equal(grant.verificationUri, 'https://auth.openai.com/codex/device');
    assert.equal(grant.interval, 5);
    assert.equal(grant.expiresAtMs, Date.parse('2026-08-21T08:00:00Z'));
  });

  it('accepts the `usercode` alias and defaults a missing interval', async () => {
    const { fetch } = fakeFetch(() => ({
      body: { device_auth_id: 'd', usercode: 'X' },
    }));
    const grant = await requestUserCode(fetch, CFG);
    assert.equal(grant.userCode, 'X');
    assert.equal(grant.interval, 5);
  });

  it('throws on a non-2xx', async () => {
    const { fetch } = fakeFetch(() => ({ ok: false, status: 429, body: {} }));
    await assert.rejects(() => requestUserCode(fetch, CFG), /user-code request failed \(429\)/);
  });
});

describe('pollDeviceToken (step 2)', () => {
  it('returns pending on any non-2xx (approval not granted yet)', async () => {
    const { fetch } = fakeFetch(() => ({ ok: false, status: 400, body: {} }));
    const r = await pollDeviceToken(fetch, CFG, { deviceAuthId: 'd', userCode: 'u' });
    assert.deepEqual(r, { status: 'pending' });
  });

  it('returns the server-generated PKCE material on approval', async () => {
    const { fetch, calls } = fakeFetch(() => ({
      body: {
        authorization_code: 'auth-xyz',
        code_challenge: 'chal',
        code_verifier: 'verif',
      },
    }));
    const r = await pollDeviceToken(fetch, CFG, { deviceAuthId: 'd', userCode: 'u' });
    assert.equal(calls[0]?.url, 'https://auth.openai.com/api/accounts/deviceauth/token');
    assert.deepEqual(JSON.parse(calls[0]!.init.body), {
      device_auth_id: 'd',
      user_code: 'u',
    });
    assert.equal(r.status, 'complete');
    if (r.status === 'complete') {
      assert.equal(r.authorizationCode, 'auth-xyz');
      assert.equal(r.codeVerifier, 'verif');
    }
  });
});

describe('exchangeAuthorizationCode (step 3)', () => {
  it('form-encodes the authorization-code grant with the device callback URI', async () => {
    const { fetch, calls } = fakeFetch(() => ({
      body: {
        access_token: 'at-1',
        refresh_token: 'rt-1',
        id_token: 'id-1',
        expires_in: 3600,
      },
    }));
    const tokens = await exchangeAuthorizationCode(
      fetch,
      CFG,
      { authorizationCode: 'auth-xyz', codeVerifier: 'verif' },
      () => 1_000_000,
    );
    assert.equal(calls[0]?.url, 'https://auth.openai.com/oauth/token');
    assert.equal(
      calls[0]?.init.headers['content-type'],
      'application/x-www-form-urlencoded',
    );
    const body = calls[0]!.init.body;
    assert.match(body, /grant_type=authorization_code/);
    assert.match(body, /code=auth-xyz/);
    assert.match(body, /redirect_uri=https%3A%2F%2Fauth.openai.com%2Fdeviceauth%2Fcallback/);
    assert.match(body, /code_verifier=verif/);
    assert.equal(tokens.accessToken, 'at-1');
    assert.equal(tokens.refreshToken, 'rt-1');
    assert.equal(tokens.expiresAt, 1_000_000 + 3600 * 1000);
  });
});

describe('refreshAccessToken', () => {
  it('sends a JSON refresh body and adopts a ROTATED refresh token', async () => {
    const { fetch, calls } = fakeFetch(() => ({
      body: { access_token: 'at-2', refresh_token: 'rt-2', expires_in: 3600 },
    }));
    const tokens = await refreshAccessToken(fetch, CFG, 'rt-1', () => 5_000);
    assert.equal(calls[0]?.init.headers['content-type'], 'application/json');
    assert.deepEqual(JSON.parse(calls[0]!.init.body), {
      client_id: CFG.clientId,
      grant_type: 'refresh_token',
      refresh_token: 'rt-1',
    });
    assert.equal(tokens.accessToken, 'at-2');
    assert.equal(tokens.refreshToken, 'rt-2'); // rotated → new one adopted
  });

  it('keeps the old refresh token when the server does not rotate it', async () => {
    const { fetch } = fakeFetch(() => ({
      body: { access_token: 'at-2', expires_in: 3600 },
    }));
    const tokens = await refreshAccessToken(fetch, CFG, 'rt-1', () => 0);
    assert.equal(tokens.refreshToken, 'rt-1');
  });

  it('throws OAuthReconnectRequiredError on a terminal reuse error', async () => {
    const { fetch } = fakeFetch(() => ({
      ok: false,
      status: 400,
      body: { error: { code: 'refresh_token_reused' } },
    }));
    await assert.rejects(
      () => refreshAccessToken(fetch, CFG, 'rt-dead', () => 0),
      OAuthReconnectRequiredError,
    );
  });

  it('throws a plain error on a transient non-terminal failure', async () => {
    const { fetch } = fakeFetch(() => ({
      ok: false,
      status: 503,
      body: { error: 'temporarily_unavailable' },
    }));
    await assert.rejects(
      () => refreshAccessToken(fetch, CFG, 'rt-1', () => 0),
      /token refresh failed \(503: temporarily_unavailable\)/,
    );
  });
});

describe('token expiry helpers', () => {
  it('derives expiry from a JWT exp claim when expires_in is absent', () => {
    // { "exp": 2000 } → 2000 * 1000 ms
    const payload = Buffer.from(JSON.stringify({ exp: 2000 })).toString('base64url');
    const jwt = `h.${payload}.sig`;
    assert.equal(jwtExpiryMs(jwt), 2_000_000);
  });

  it('isAccessTokenExpired respects the skew and the no-expiry case', () => {
    assert.equal(isAccessTokenExpired(undefined, 0), true);
    assert.equal(
      isAccessTokenExpired({ accessToken: 'a' }, 999_999_999), // no expiresAt → valid
      false,
    );
    // now well before (expiresAt − 60s skew) → still valid.
    assert.equal(
      isAccessTokenExpired({ accessToken: 'a', expiresAt: 100_000 }, 10_000),
      false,
    );
    // now inside the 60s skew window before expiry → treated as expired.
    assert.equal(
      isAccessTokenExpired({ accessToken: 'a', expiresAt: 100_000 }, 50_000),
      true,
    );
    assert.equal(
      isAccessTokenExpired({ accessToken: 'a', expiresAt: 100_000 }, 100_000),
      true,
    );
  });
});
