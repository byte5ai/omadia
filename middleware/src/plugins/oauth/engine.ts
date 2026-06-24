/**
 * Spec 005 — declarative OAuth-2 engine (authorization-code + PKCE + refresh).
 *
 * Executes the whole OAuth dance from an inert {@link OAuthProviderDescriptor}
 * (pure manifest data). There is NO per-provider class and NO plugin code in
 * the loop, so the client secret and refresh tokens stay kernel-side — a
 * plugin can declare a descriptor but can never intercept the code exchange or
 * see a refresh token.
 *
 * The retired `MicrosoftGraphProvider` collapses into a `body_form` +
 * `{tenant_id}` descriptor; Atlassian 3LO is a `body_json` descriptor with an
 * `audience` extra-authorize param. Both are exercised in
 * `test/oauth/engine.test.ts`.
 *
 * `token_auth_style`:
 *  - `body_form` — x-www-form-urlencoded body; client_id + client_secret in
 *    the body (Microsoft).
 *  - `body_json` — JSON body; client_id + client_secret in the body
 *    (Atlassian / Auth0).
 *  - `basic` — HTTP Basic auth header for the client creds; grant params
 *    urlencoded in the body.
 */

import type { OAuthProviderDescriptor } from '../../api/admin-v1.js';

export interface OAuthEngineTokens {
  /** Bearer access token (short-lived). */
  accessToken: string;
  /** Rotated/issued refresh token, or '' when the provider returns none. The
   *  engine stays lenient; the caller keeps any previously-stored refresh
   *  token when this is empty. */
  refreshToken: string;
  /** ISO-8601 absolute expiry, computed from `expires_in` at call time. */
  expiresAt: string;
  /** Space-separated granted scopes ('' when the provider omits them). */
  scope: string;
}

export interface AuthorizeUrlParams {
  descriptor: OAuthProviderDescriptor;
  clientId: string;
  redirectUri: string;
  scopes: string[];
  /** Signed-state token (opaque to the engine). */
  state: string;
  /** S256 challenge; required iff `descriptor.pkce`. */
  codeChallenge?: string;
  /** Values for `{field}` interpolation in `authorize_url`. */
  configValues?: Record<string, string>;
  /** Optional consent-screen locale hint (`ui_locales`). */
  uiLocale?: string;
}

export interface ExchangeCodeParams {
  descriptor: OAuthProviderDescriptor;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  code: string;
  /** Raw PKCE verifier; required iff `descriptor.pkce`. */
  codeVerifier?: string;
  scopes: string[];
  configValues?: Record<string, string>;
}

export interface RefreshParams {
  descriptor: OAuthProviderDescriptor;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  scopes: string[];
  configValues?: Record<string, string>;
}

/** Engine-owned authorize params a descriptor's `extra_authorize_params` may
 *  not override (it could otherwise forge the redirect target or drop PKCE). */
const RESERVED_AUTHORIZE_PARAMS = new Set([
  'client_id',
  'response_type',
  'redirect_uri',
  'scope',
  'state',
  'code_challenge',
  'code_challenge_method',
  'ui_locales',
]);

/** Replace `{field}` placeholders in a descriptor URL with stored config
 *  values (e.g. Microsoft's `{tenant_id}`). Throws when a referenced field is
 *  absent so a misconfigured connection fails loudly, not silently. */
function interpolate(
  template: string,
  values: Record<string, string> | undefined,
): string {
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (_match, key: string) => {
    const value = values?.[key];
    if (value === undefined || value === '') {
      throw new Error(
        `oauth descriptor URL references missing config field {${key}}`,
      );
    }
    return value;
  });
}

export function buildAuthorizeUrl(params: AuthorizeUrlParams): string {
  const { descriptor } = params;
  const url = new URL(interpolate(descriptor.authorize_url, params.configValues));
  const sp = url.searchParams;
  sp.set('client_id', params.clientId);
  sp.set('response_type', 'code');
  sp.set('redirect_uri', params.redirectUri);
  sp.set('scope', params.scopes.join(' '));
  sp.set('state', params.state);
  if (descriptor.pkce) {
    if (!params.codeChallenge) {
      throw new Error(
        `oauth provider '${descriptor.id}' requires PKCE but no codeChallenge was supplied`,
      );
    }
    sp.set('code_challenge', params.codeChallenge);
    sp.set('code_challenge_method', 'S256');
  }
  for (const [key, value] of Object.entries(
    descriptor.extra_authorize_params ?? {},
  )) {
    if (RESERVED_AUTHORIZE_PARAMS.has(key)) continue;
    sp.set(key, value);
  }
  if (params.uiLocale) sp.set('ui_locales', params.uiLocale);
  return url.toString();
}

export async function exchangeCode(
  params: ExchangeCodeParams,
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now,
): Promise<OAuthEngineTokens> {
  const { descriptor } = params;
  const fields: Record<string, string> = {
    grant_type: 'authorization_code',
    code: params.code,
    redirect_uri: params.redirectUri,
    scope: params.scopes.join(' '),
  };
  if (descriptor.pkce) {
    if (!params.codeVerifier) {
      throw new Error(
        `oauth provider '${descriptor.id}' requires PKCE but no codeVerifier was supplied`,
      );
    }
    fields['code_verifier'] = params.codeVerifier;
  }
  return await postToken(
    descriptor,
    params.clientId,
    params.clientSecret,
    fields,
    params.configValues,
    fetchImpl,
    now,
  );
}

export async function refreshAccessToken(
  params: RefreshParams,
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now,
): Promise<OAuthEngineTokens> {
  const fields: Record<string, string> = {
    grant_type: 'refresh_token',
    refresh_token: params.refreshToken,
    scope: params.scopes.join(' '),
  };
  return await postToken(
    params.descriptor,
    params.clientId,
    params.clientSecret,
    fields,
    params.configValues,
    fetchImpl,
    now,
  );
}

async function postToken(
  descriptor: OAuthProviderDescriptor,
  clientId: string,
  clientSecret: string,
  fields: Record<string, string>,
  configValues: Record<string, string> | undefined,
  fetchImpl: typeof fetch,
  now: () => number,
): Promise<OAuthEngineTokens> {
  const tokenUrl = interpolate(descriptor.token_url, configValues);
  const headers: Record<string, string> = { accept: 'application/json' };
  const payload: Record<string, string> = { ...fields };
  let body: string;

  if (descriptor.token_auth_style === 'basic') {
    const creds = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    headers['authorization'] = `Basic ${creds}`;
    headers['content-type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(payload).toString();
  } else if (descriptor.token_auth_style === 'body_json') {
    payload['client_id'] = clientId;
    payload['client_secret'] = clientSecret;
    headers['content-type'] = 'application/json';
    body = JSON.stringify(payload);
  } else {
    // body_form (Microsoft + default)
    payload['client_id'] = clientId;
    payload['client_secret'] = clientSecret;
    headers['content-type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(payload).toString();
  }

  const res = await fetchImpl(tokenUrl, { method: 'POST', headers, body });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`oauth token endpoint ${res.status}: ${text}`);
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error('oauth token endpoint returned non-JSON');
  }
  const accessToken =
    typeof parsed['access_token'] === 'string' ? parsed['access_token'] : '';
  if (!accessToken) {
    throw new Error('oauth token response missing access_token');
  }
  const refreshToken =
    typeof parsed['refresh_token'] === 'string' ? parsed['refresh_token'] : '';
  const expiresInRaw = parsed['expires_in'];
  const expiresIn =
    typeof expiresInRaw === 'number'
      ? expiresInRaw
      : typeof expiresInRaw === 'string'
        ? Number(expiresInRaw)
        : NaN;
  if (!Number.isFinite(expiresIn)) {
    throw new Error('oauth token response missing expires_in');
  }
  const scope = typeof parsed['scope'] === 'string' ? parsed['scope'] : '';
  const expiresAt = new Date(now() + expiresIn * 1000).toISOString();
  return { accessToken, refreshToken, expiresAt, scope };
}
