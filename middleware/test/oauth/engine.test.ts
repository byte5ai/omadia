/**
 * Spec 005 T22 — the declarative OAuth engine.
 *
 * The Microsoft descriptor is a regression fixture: it proves the engine
 * reproduces the exact authorize/token/refresh requests the retired
 * `MicrosoftGraphProvider` class produced (incl. `{tenant_id}` interpolation
 * and the `body_form` token style). Atlassian exercises the `body_json` style
 * + an `audience` extra-authorize param. Generic error handling + the
 * reserved-param guard + missing-config interpolation round it out.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { OAuthProviderDescriptor } from '../../src/api/admin-v1.js';
import {
  buildAuthorizeUrl,
  exchangeCode,
  refreshAccessToken,
} from '../../src/plugins/oauth/engine.js';

// --- fixtures --------------------------------------------------------------

const msDescriptor: OAuthProviderDescriptor = {
  id: 'microsoft365',
  authorize_url:
    'https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/authorize',
  token_url: 'https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token',
  token_auth_style: 'body_form',
  pkce: true,
  extra_authorize_params: { response_mode: 'query', prompt: 'select_account' },
  client_id_field: 'client_id',
  client_secret_field: 'client_secret',
};
const msConfig = { tenant_id: 'tenant-uuid' };

const atlassianDescriptor: OAuthProviderDescriptor = {
  id: 'atlassian',
  authorize_url: 'https://auth.atlassian.com/authorize',
  token_url: 'https://auth.atlassian.com/oauth/token',
  token_auth_style: 'body_json',
  pkce: true,
  extra_authorize_params: { audience: 'api.atlassian.com', prompt: 'consent' },
  client_id_field: 'client_id',
  client_secret_field: 'client_secret',
};

function jsonFetch(payload: unknown, status = 200): {
  fetchImpl: typeof fetch;
  captured: () => { url: string; body: string; headers: Record<string, string> };
} {
  let cap: { url: string; body: string; headers: Record<string, string> } = {
    url: '',
    body: '',
    headers: {},
  };
  const fetchImpl: typeof fetch = async (url, init) => {
    cap = {
      url: String(url),
      body: String((init as { body?: BodyInit }).body),
      headers: ((init as { headers?: Record<string, string> }).headers ??
        {}) as Record<string, string>,
    };
    return new Response(
      typeof payload === 'string' ? payload : JSON.stringify(payload),
      { status },
    );
  };
  return { fetchImpl, captured: () => cap };
}

const fixedNow = (): number => Date.parse('2026-06-16T12:00:00.000Z');

// --- Microsoft regression fixture -----------------------------------------

test('MS fixture: buildAuthorizeUrl reproduces the Microsoft authorize request', () => {
  const url = new URL(
    buildAuthorizeUrl({
      descriptor: msDescriptor,
      clientId: 'client-uuid',
      redirectUri: 'https://app.example/api/v1/install/oauth/callback',
      scopes: ['Calendars.Read', 'offline_access'],
      state: 'STATE-JWT',
      codeChallenge: 'CHALLENGE',
      configValues: msConfig,
      uiLocale: 'de',
    }),
  );
  assert.equal(
    url.origin + url.pathname,
    'https://login.microsoftonline.com/tenant-uuid/oauth2/v2.0/authorize',
  );
  assert.equal(url.searchParams.get('client_id'), 'client-uuid');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(
    url.searchParams.get('redirect_uri'),
    'https://app.example/api/v1/install/oauth/callback',
  );
  assert.equal(url.searchParams.get('scope'), 'Calendars.Read offline_access');
  assert.equal(url.searchParams.get('state'), 'STATE-JWT');
  assert.equal(url.searchParams.get('code_challenge'), 'CHALLENGE');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('response_mode'), 'query');
  assert.equal(url.searchParams.get('prompt'), 'select_account');
  assert.equal(url.searchParams.get('ui_locales'), 'de');
});

test('MS fixture: exchangeCode posts the form body to the interpolated token URL', async () => {
  const { fetchImpl, captured } = jsonFetch({
    access_token: 'AT-1',
    refresh_token: 'RT-1',
    expires_in: 3600,
    scope: 'Calendars.Read offline_access',
    token_type: 'Bearer',
  });
  const tokens = await exchangeCode(
    {
      descriptor: msDescriptor,
      clientId: 'client-uuid',
      clientSecret: 'secret-shh',
      redirectUri: 'https://app.example/cb',
      code: 'auth-code',
      codeVerifier: 'pkce-verifier',
      scopes: ['Calendars.Read', 'offline_access'],
      configValues: msConfig,
    },
    fetchImpl,
    fixedNow,
  );
  const c = captured();
  assert.equal(
    c.url,
    'https://login.microsoftonline.com/tenant-uuid/oauth2/v2.0/token',
  );
  assert.match(c.headers['content-type'] ?? '', /x-www-form-urlencoded/);
  const body = new URLSearchParams(c.body);
  assert.equal(body.get('grant_type'), 'authorization_code');
  assert.equal(body.get('code'), 'auth-code');
  assert.equal(body.get('code_verifier'), 'pkce-verifier');
  assert.equal(body.get('redirect_uri'), 'https://app.example/cb');
  assert.equal(body.get('scope'), 'Calendars.Read offline_access');
  assert.equal(body.get('client_id'), 'client-uuid');
  assert.equal(body.get('client_secret'), 'secret-shh');
  assert.equal(tokens.accessToken, 'AT-1');
  assert.equal(tokens.refreshToken, 'RT-1');
  assert.equal(tokens.expiresAt, '2026-06-16T13:00:00.000Z');
});

test('MS fixture: refreshAccessToken sends grant_type=refresh_token + propagates rotated RT', async () => {
  const { fetchImpl, captured } = jsonFetch({
    access_token: 'AT-2',
    refresh_token: 'RT-2-rotated',
    expires_in: 3600,
  });
  const tokens = await refreshAccessToken(
    {
      descriptor: msDescriptor,
      clientId: 'client-uuid',
      clientSecret: 'secret-shh',
      refreshToken: 'OLD-RT',
      scopes: ['Calendars.Read', 'offline_access'],
      configValues: msConfig,
    },
    fetchImpl,
  );
  const body = new URLSearchParams(captured().body);
  assert.equal(body.get('grant_type'), 'refresh_token');
  assert.equal(body.get('refresh_token'), 'OLD-RT');
  assert.equal(tokens.refreshToken, 'RT-2-rotated');
});

// --- Atlassian (body_json) dialect ----------------------------------------

test('Atlassian: authorize URL carries audience + prompt + PKCE, no interpolation', () => {
  const url = new URL(
    buildAuthorizeUrl({
      descriptor: atlassianDescriptor,
      clientId: 'atl-client',
      redirectUri: 'https://app.example/api/v1/install/oauth/callback',
      scopes: ['read:jira-work', 'offline_access'],
      state: 'S',
      codeChallenge: 'CH',
    }),
  );
  assert.equal(url.origin + url.pathname, 'https://auth.atlassian.com/authorize');
  assert.equal(url.searchParams.get('audience'), 'api.atlassian.com');
  assert.equal(url.searchParams.get('prompt'), 'consent');
  assert.equal(url.searchParams.get('code_challenge'), 'CH');
  assert.equal(url.searchParams.get('scope'), 'read:jira-work offline_access');
});

test('Atlassian: exchangeCode posts a JSON body with creds + code_verifier', async () => {
  const { fetchImpl, captured } = jsonFetch({
    access_token: 'AT',
    refresh_token: 'RT',
    expires_in: 3600,
    scope: 'read:jira-work',
  });
  await exchangeCode(
    {
      descriptor: atlassianDescriptor,
      clientId: 'atl-client',
      clientSecret: 'atl-secret',
      redirectUri: 'https://app.example/cb',
      code: 'C',
      codeVerifier: 'V',
      scopes: ['read:jira-work', 'offline_access'],
    },
    fetchImpl,
  );
  const c = captured();
  assert.equal(c.url, 'https://auth.atlassian.com/oauth/token');
  assert.match(c.headers['content-type'] ?? '', /application\/json/);
  const parsed = JSON.parse(c.body) as Record<string, string>;
  assert.equal(parsed['grant_type'], 'authorization_code');
  assert.equal(parsed['client_id'], 'atl-client');
  assert.equal(parsed['client_secret'], 'atl-secret');
  assert.equal(parsed['code'], 'C');
  assert.equal(parsed['code_verifier'], 'V');
});

// --- basic auth style ------------------------------------------------------

test('basic style sends Authorization: Basic and omits creds from the body', async () => {
  const basicDescriptor: OAuthProviderDescriptor = {
    ...atlassianDescriptor,
    id: 'basic-idp',
    token_auth_style: 'basic',
    pkce: false,
  };
  const { fetchImpl, captured } = jsonFetch({
    access_token: 'AT',
    expires_in: 3600,
  });
  await exchangeCode(
    {
      descriptor: basicDescriptor,
      clientId: 'cid',
      clientSecret: 'csecret',
      redirectUri: 'https://app/cb',
      code: 'C',
      scopes: ['x'],
    },
    fetchImpl,
  );
  const c = captured();
  assert.equal(
    c.headers['authorization'],
    `Basic ${Buffer.from('cid:csecret').toString('base64')}`,
  );
  const body = new URLSearchParams(c.body);
  assert.equal(body.get('client_id'), null);
  assert.equal(body.get('client_secret'), null);
  assert.equal(body.get('code'), 'C');
});

// --- generic error handling + guards --------------------------------------

test('throws on non-2xx with status + body', async () => {
  const { fetchImpl } = jsonFetch('{"error":"invalid_grant"}', 400);
  await assert.rejects(
    () =>
      exchangeCode(
        {
          descriptor: atlassianDescriptor,
          clientId: 'c',
          clientSecret: 's',
          redirectUri: 'r',
          code: 'x',
          codeVerifier: 'v',
          scopes: [],
        },
        fetchImpl,
      ),
    /token endpoint 400/,
  );
});

test('throws on non-JSON token response', async () => {
  const { fetchImpl } = jsonFetch('definitely not json', 200);
  await assert.rejects(
    () =>
      refreshAccessToken(
        {
          descriptor: atlassianDescriptor,
          clientId: 'c',
          clientSecret: 's',
          refreshToken: 'rt',
          scopes: [],
        },
        fetchImpl,
      ),
    /non-JSON/,
  );
});

test('throws when access_token / expires_in are missing', async () => {
  const noAccess = jsonFetch({ refresh_token: 'rt', expires_in: 3600 });
  await assert.rejects(
    () =>
      refreshAccessToken(
        {
          descriptor: msDescriptor,
          clientId: 'c',
          clientSecret: 's',
          refreshToken: 'rt',
          scopes: [],
          configValues: msConfig,
        },
        noAccess.fetchImpl,
      ),
    /missing access_token/,
  );
  const noExpiry = jsonFetch({ access_token: 'at' });
  await assert.rejects(
    () =>
      refreshAccessToken(
        {
          descriptor: msDescriptor,
          clientId: 'c',
          clientSecret: 's',
          refreshToken: 'rt',
          scopes: [],
          configValues: msConfig,
        },
        noExpiry.fetchImpl,
      ),
    /missing expires_in/,
  );
});

test('interpolation throws when a referenced config field is absent', () => {
  assert.throws(
    () =>
      buildAuthorizeUrl({
        descriptor: msDescriptor,
        clientId: 'c',
        redirectUri: 'r',
        scopes: [],
        state: 's',
        codeChallenge: 'ch',
        configValues: {}, // no tenant_id
      }),
    /missing config field \{tenant_id\}/,
  );
});

test('extra_authorize_params cannot override engine-owned params', () => {
  const hostile: OAuthProviderDescriptor = {
    ...atlassianDescriptor,
    extra_authorize_params: {
      redirect_uri: 'https://evil.example/steal',
      audience: 'api.atlassian.com',
    },
  };
  const url = new URL(
    buildAuthorizeUrl({
      descriptor: hostile,
      clientId: 'c',
      redirectUri: 'https://app.example/cb',
      scopes: ['x'],
      state: 's',
      codeChallenge: 'ch',
    }),
  );
  assert.equal(url.searchParams.get('redirect_uri'), 'https://app.example/cb');
  assert.equal(url.searchParams.get('audience'), 'api.atlassian.com');
});

test('pkce descriptor without a challenge/verifier is rejected', async () => {
  assert.throws(
    () =>
      buildAuthorizeUrl({
        descriptor: atlassianDescriptor,
        clientId: 'c',
        redirectUri: 'r',
        scopes: [],
        state: 's',
      }),
    /requires PKCE but no codeChallenge/,
  );
});
