import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MicrosoftGraphProvider,
  microsoftGraphProviderFactory,
} from '../../src/plugins/oauth/microsoftGraphProvider.js';

const baseCfg = {
  tenantId: 'tenant-uuid',
  clientId: 'client-uuid',
  clientSecret: 'secret-shh',
};

test('buildAuthorizeUrl includes all required OAuth2 + PKCE params', () => {
  const p = new MicrosoftGraphProvider(baseCfg);
  const url = new URL(
    p.buildAuthorizeUrl({
      state: 'STATE-JWT',
      codeChallenge: 'CHALLENGE',
      scopes: ['Calendars.Read', 'offline_access'],
      redirectUri: 'https://app.example/api/install/oauth/callback',
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
    'https://app.example/api/install/oauth/callback',
  );
  assert.equal(
    url.searchParams.get('scope'),
    'Calendars.Read offline_access',
  );
  assert.equal(url.searchParams.get('state'), 'STATE-JWT');
  assert.equal(url.searchParams.get('code_challenge'), 'CHALLENGE');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('prompt'), 'select_account');
});

test('buildAuthorizeUrl forwards uiLocale when provided', () => {
  const p = new MicrosoftGraphProvider(baseCfg);
  const url = new URL(
    p.buildAuthorizeUrl({
      state: 's',
      codeChallenge: 'c',
      scopes: ['User.Read'],
      redirectUri: 'https://x/cb',
      uiLocale: 'de',
    }),
  );
  assert.equal(url.searchParams.get('ui_locales'), 'de');
});

test('exchangeCode posts the right form body and parses the response', async () => {
  let captured: { url: string; body: string } | null = null;
  const fakeFetch: typeof fetch = async (url, init) => {
    captured = {
      url: String(url),
      body: String((init as { body?: BodyInit }).body),
    };
    return new Response(
      JSON.stringify({
        access_token: 'AT-1',
        refresh_token: 'RT-1',
        expires_in: 3600,
        scope: 'Calendars.Read offline_access',
        token_type: 'Bearer',
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
  const fixedNow = (): number => Date.parse('2026-05-08T12:00:00.000Z');
  const p = new MicrosoftGraphProvider(baseCfg, fakeFetch, fixedNow);
  const tokens = await p.exchangeCode(
    'auth-code',
    'pkce-verifier',
    'https://app.example/cb',
    ['Calendars.Read', 'offline_access'],
  );
  assert.equal(
    captured?.url,
    'https://login.microsoftonline.com/tenant-uuid/oauth2/v2.0/token',
  );
  const body = new URLSearchParams(captured!.body);
  assert.equal(body.get('grant_type'), 'authorization_code');
  assert.equal(body.get('code'), 'auth-code');
  assert.equal(body.get('code_verifier'), 'pkce-verifier');
  assert.equal(body.get('redirect_uri'), 'https://app.example/cb');
  assert.equal(body.get('scope'), 'Calendars.Read offline_access');
  assert.equal(body.get('client_id'), 'client-uuid');
  assert.equal(body.get('client_secret'), 'secret-shh');
  assert.equal(tokens.accessToken, 'AT-1');
  assert.equal(tokens.refreshToken, 'RT-1');
  assert.equal(tokens.scope, 'Calendars.Read offline_access');
  assert.equal(tokens.expiresAt, '2026-05-08T13:00:00.000Z');
});

test('refreshAccessToken posts grant_type=refresh_token + propagates rotated RT', async () => {
  let captured = '';
  const fakeFetch: typeof fetch = async (_url, init) => {
    captured = String((init as { body?: BodyInit }).body);
    return new Response(
      JSON.stringify({
        access_token: 'AT-2',
        refresh_token: 'RT-2-rotated',
        expires_in: 3600,
        scope: 'Calendars.Read offline_access',
      }),
      { status: 200 },
    );
  };
  const p = new MicrosoftGraphProvider(baseCfg, fakeFetch);
  const tokens = await p.refreshAccessToken('OLD-RT', [
    'Calendars.Read',
    'offline_access',
  ]);
  const body = new URLSearchParams(captured);
  assert.equal(body.get('grant_type'), 'refresh_token');
  assert.equal(body.get('refresh_token'), 'OLD-RT');
  assert.equal(tokens.refreshToken, 'RT-2-rotated');
});

test('exchangeCode throws on non-2xx with the body included', async () => {
  const fakeFetch: typeof fetch = async () =>
    new Response('{"error":"invalid_grant"}', { status: 400 });
  const p = new MicrosoftGraphProvider(baseCfg, fakeFetch);
  await assert.rejects(
    () => p.exchangeCode('c', 'v', 'r', []),
    /microsoft365 token endpoint 400/,
  );
});

test('postToken throws when access_token is missing', async () => {
  const fakeFetch: typeof fetch = async () =>
    new Response(
      JSON.stringify({ refresh_token: 'rt', expires_in: 3600 }),
      { status: 200 },
    );
  const p = new MicrosoftGraphProvider(baseCfg, fakeFetch);
  await assert.rejects(
    () => p.exchangeCode('c', 'v', 'r', []),
    /missing access_token/,
  );
});

test('postToken throws when refresh_token is missing (offline_access likely dropped)', async () => {
  const fakeFetch: typeof fetch = async () =>
    new Response(
      JSON.stringify({ access_token: 'at', expires_in: 3600 }),
      { status: 200 },
    );
  const p = new MicrosoftGraphProvider(baseCfg, fakeFetch);
  await assert.rejects(
    () => p.exchangeCode('c', 'v', 'r', ['Calendars.Read']),
    /missing refresh_token/,
  );
});

test('postToken throws on non-JSON response body', async () => {
  const fakeFetch: typeof fetch = async () =>
    new Response('not really JSON', { status: 200 });
  const p = new MicrosoftGraphProvider(baseCfg, fakeFetch);
  await assert.rejects(
    () => p.exchangeCode('c', 'v', 'r', []),
    /non-JSON/,
  );
});

test('factory builds a provider from a valid config object', () => {
  const p = microsoftGraphProviderFactory(baseCfg);
  assert.equal(p.id, 'microsoft365');
  assert.equal(p.displayName, 'Microsoft 365');
});

test('factory throws on missing fields', () => {
  assert.throws(
    () => microsoftGraphProviderFactory({ tenantId: 't', clientId: 'c' }),
    /requires tenantId, clientId, clientSecret/,
  );
});

test('factory throws on non-object config', () => {
  assert.throws(
    () => microsoftGraphProviderFactory(null),
    /needs a config object/,
  );
});
