/**
 * "Sign in with ChatGPT" device-code login (phase 4b — EXPERIMENTAL).
 *
 * ⚠️ EXPERIMENTAL / ToS GREY AREA. Using a ChatGPT-subscription login to drive
 * programmatic API calls lives in a grey area of OpenAI's terms — surface a
 * clear notice in the UI and do not market it as an enterprise feature.
 *
 * This is NOT RFC 8628. The live protocol (verified 2026-08-21 against
 * auth.openai.com and the open-source codex CLI, codex-rs/login/src/
 * device_code_auth.rs + server.rs) is a custom three-step flow:
 *
 *   1. `POST {issuer}/api/accounts/deviceauth/usercode`, JSON `{client_id}`
 *      → `{device_auth_id, user_code, interval, expires_at}`. The operator
 *      visits `{issuer}/codex/device` and enters the user code.
 *   2. Poll `POST {issuer}/api/accounts/deviceauth/token`, JSON
 *      `{device_auth_id, user_code}` — non-2xx while pending; on approval
 *      → `{authorization_code, code_challenge, code_verifier}` (PKCE is
 *      generated SERVER-side).
 *   3. `POST {issuer}/oauth/token`, form-encoded authorization-code exchange
 *      with `redirect_uri={issuer}/deviceauth/callback` and the server-supplied
 *      `code_verifier` → `{id_token, access_token, refresh_token}`.
 *
 * Refresh: `POST {issuer}/oauth/token` with a JSON body
 * `{client_id, grant_type:"refresh_token", refresh_token}`. The server MAY
 * rotate the refresh token (reuse of a rotated one is a terminal
 * `refresh_token_reused` error), so callers must persist rotated tokens —
 * see `providerOAuthTokenStore`.
 *
 * Every function takes its config + a `fetch` implementation so tests never
 * depend on the live endpoints. All calls send an explicit browser-like
 * User-Agent: the default Node/python UA gets a Cloudflare challenge page.
 */

/** OpenAI Codex public OAuth client configuration. */
export interface OAuthClientConfig {
  /** Auth issuer base URL; all endpoint paths derive from it. */
  readonly issuer: string;
  readonly clientId: string;
  /** Explicit UA — required, default UAs are Cloudflare-challenged. */
  readonly userAgent: string;
}

/** Default OpenAI Codex client (issuer verified live 2026-08-21). */
export const OPENAI_CODEX_OAUTH: OAuthClientConfig = {
  issuer: 'https://auth.openai.com',
  clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) omadia-oauth',
};

/** Step-1 result: what the operator needs + what the poll needs. */
export interface UserCodeGrant {
  readonly deviceAuthId: string;
  readonly userCode: string;
  /** Human verification URL (client-constructed: `{issuer}/codex/device`). */
  readonly verificationUri: string;
  /** Minimum seconds between polls. */
  readonly interval: number;
  /** Absolute epoch-ms expiry of the device code, when the server sends one. */
  readonly expiresAtMs?: number;
}

export interface OAuthTokens {
  readonly accessToken: string;
  readonly refreshToken?: string;
  /** Absolute epoch-ms expiry (from `expires_in`, else the JWT `exp` claim). */
  readonly expiresAt?: number;
  readonly tokenType?: string;
  readonly idToken?: string;
}

/** Outcome of a single step-2 poll. */
export type PollResult =
  /** Approved — carry the server-generated PKCE verifier into step 3. */
  | {
      readonly status: 'complete';
      readonly authorizationCode: string;
      readonly codeVerifier: string;
    }
  /** Not approved yet (any non-2xx) — poll again after `interval`. The caller
   *  owns the deadline (`expiresAtMs` / 15-min cap) and maps it to expired. */
  | { readonly status: 'pending' };

export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
  },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

/** Wall clock injected so token-expiry math is deterministic in tests. */
export type NowMs = () => number;

/** Refresh failed terminally — the stored grant is dead; reconnect required. */
export class OAuthReconnectRequiredError extends Error {
  constructor(readonly code: string) {
    super(`oauth: refresh grant is no longer usable (${code}) — sign in again`);
    // Set explicitly: subclass constructors do NOT set `name` (it stays
    // 'Error'), and the openai-responses adapter classifies a dead grant by
    // `err.name` across a package boundary where `instanceof` can't reach.
    this.name = 'OAuthReconnectRequiredError';
  }
}

function form(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

function asRecord(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** Decode a base64url segment to a UTF-8 string, without a node/DOM global
 *  (this package is deliberately SDK- and node-types-free like its siblings). */
function base64UrlToString(input: string): string {
  const b64 = input.replace(/-/g, '+').replace(/_/g, '/');
  const chars =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of b64) {
    const idx = chars.indexOf(ch);
    if (idx === -1) continue; // padding '=' and stray chars
    buffer = (buffer << 6) | idx;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  // Minimal UTF-8 decode (JWT payloads are ASCII/JSON in practice).
  let out = '';
  for (let i = 0; i < bytes.length; ) {
    const b0 = bytes[i]!;
    if (b0 < 0x80) {
      out += String.fromCharCode(b0);
      i += 1;
    } else if (b0 < 0xe0) {
      out += String.fromCharCode(((b0 & 0x1f) << 6) | (bytes[i + 1]! & 0x3f));
      i += 2;
    } else {
      out += String.fromCharCode(
        ((b0 & 0x0f) << 12) | ((bytes[i + 1]! & 0x3f) << 6) | (bytes[i + 2]! & 0x3f),
      );
      i += 3;
    }
  }
  return out;
}

/** Decode the `exp` claim (epoch seconds → ms) of a JWT. No verification —
 *  this is our own token and only feeds proactive-refresh timing. */
export function jwtExpiryMs(token: string): number | undefined {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[1] === undefined) return undefined;
  try {
    const payload = asRecord(JSON.parse(base64UrlToString(parts[1])));
    const exp = num(payload['exp']);
    return exp !== undefined ? exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

function toTokens(body: unknown, nowMs: number): OAuthTokens {
  const b = asRecord(body);
  const accessToken = str(b['access_token']);
  if (accessToken === undefined) {
    throw new Error('oauth: token response missing access_token');
  }
  const expiresIn = num(b['expires_in']);
  const expiresAt =
    expiresIn !== undefined ? nowMs + expiresIn * 1000 : jwtExpiryMs(accessToken);
  return {
    accessToken,
    ...(str(b['refresh_token']) !== undefined
      ? { refreshToken: str(b['refresh_token']) }
      : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    ...(str(b['token_type']) !== undefined ? { tokenType: str(b['token_type']) } : {}),
    ...(str(b['id_token']) !== undefined ? { idToken: str(b['id_token']) } : {}),
  };
}

function baseHeaders(config: OAuthClientConfig): Record<string, string> {
  return { 'user-agent': config.userAgent, accept: 'application/json' };
}

function issuerUrl(config: OAuthClientConfig, path: string): string {
  return `${config.issuer.replace(/\/+$/, '')}${path}`;
}

/** Step 1 — request a user code. The operator then visits `verificationUri`
 *  and enters `userCode`. */
export async function requestUserCode(
  fetchImpl: FetchLike,
  config: OAuthClientConfig,
): Promise<UserCodeGrant> {
  const res = await fetchImpl(issuerUrl(config, '/api/accounts/deviceauth/usercode'), {
    method: 'POST',
    headers: { ...baseHeaders(config), 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: config.clientId }),
  });
  if (!res.ok) {
    throw new Error(`oauth: user-code request failed (${String(res.status)})`);
  }
  const b = asRecord(await res.json());
  const deviceAuthId = str(b['device_auth_id']);
  const userCode = str(b['user_code']) ?? str(b['usercode']);
  if (deviceAuthId === undefined || userCode === undefined) {
    throw new Error('oauth: user-code response missing codes');
  }
  const expiresAt = str(b['expires_at']);
  const expiresAtMs = expiresAt !== undefined ? Date.parse(expiresAt) : NaN;
  return {
    deviceAuthId,
    userCode,
    verificationUri: issuerUrl(config, '/codex/device'),
    interval: num(b['interval']) ?? 5,
    ...(Number.isFinite(expiresAtMs) ? { expiresAtMs } : {}),
  };
}

/** Step 2 — poll once for approval. Non-2xx means "not approved yet"; the
 *  caller owns the deadline and turns it into `expired`. */
export async function pollDeviceToken(
  fetchImpl: FetchLike,
  config: OAuthClientConfig,
  grant: Pick<UserCodeGrant, 'deviceAuthId' | 'userCode'>,
): Promise<PollResult> {
  const res = await fetchImpl(issuerUrl(config, '/api/accounts/deviceauth/token'), {
    method: 'POST',
    headers: { ...baseHeaders(config), 'content-type': 'application/json' },
    body: JSON.stringify({
      device_auth_id: grant.deviceAuthId,
      user_code: grant.userCode,
    }),
  });
  if (!res.ok) {
    return { status: 'pending' };
  }
  const b = asRecord(await res.json());
  const authorizationCode = str(b['authorization_code']);
  const codeVerifier = str(b['code_verifier']);
  if (authorizationCode === undefined || codeVerifier === undefined) {
    throw new Error('oauth: approval response missing authorization code');
  }
  return { status: 'complete', authorizationCode, codeVerifier };
}

/** Step 3 — exchange the approval for tokens (form-encoded, per the CLI). */
export async function exchangeAuthorizationCode(
  fetchImpl: FetchLike,
  config: OAuthClientConfig,
  approval: { authorizationCode: string; codeVerifier: string },
  nowMs: NowMs,
): Promise<OAuthTokens> {
  const res = await fetchImpl(issuerUrl(config, '/oauth/token'), {
    method: 'POST',
    headers: {
      ...baseHeaders(config),
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: form({
      grant_type: 'authorization_code',
      code: approval.authorizationCode,
      redirect_uri: issuerUrl(config, '/deviceauth/callback'),
      client_id: config.clientId,
      code_verifier: approval.codeVerifier,
    }),
  });
  if (!res.ok) {
    throw new Error(`oauth: code exchange failed (${String(res.status)})`);
  }
  return toTokens(await res.json(), nowMs());
}

/** Error codes auth.openai.com uses for a dead refresh grant (from the CLI's
 *  classify_refresh_token_failure). */
const TERMINAL_REFRESH_CODES = new Set([
  'refresh_token_expired',
  'refresh_token_reused',
  'refresh_token_invalidated',
  'invalid_grant',
]);

/** Refresh an expired access token (JSON body, per the CLI — NOT form-encoded).
 *  The server may rotate the refresh token; when it does, the OLD one is dead
 *  and the returned one MUST be persisted. Terminal grant failures throw
 *  {@link OAuthReconnectRequiredError}. */
export async function refreshAccessToken(
  fetchImpl: FetchLike,
  config: OAuthClientConfig,
  refreshToken: string,
  nowMs: NowMs,
): Promise<OAuthTokens> {
  const res = await fetchImpl(issuerUrl(config, '/oauth/token'), {
    method: 'POST',
    headers: { ...baseHeaders(config), 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: config.clientId,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  });
  if (!res.ok) {
    const body = asRecord(await res.json().catch(() => ({})));
    const code =
      str(asRecord(body['error'])['code']) ?? str(body['error']) ?? 'unknown';
    if (TERMINAL_REFRESH_CODES.has(code)) {
      throw new OAuthReconnectRequiredError(code);
    }
    throw new Error(`oauth: token refresh failed (${String(res.status)}: ${code})`);
  }
  const tokens = toTokens(await res.json(), nowMs());
  // Preserve the existing refresh token when the server doesn't rotate it.
  return tokens.refreshToken !== undefined
    ? tokens
    : { ...tokens, refreshToken };
}

/** True when the access token is missing or within `skewMs` of expiry (default
 *  60s) and should be refreshed before use. Tokens with no known expiry are
 *  treated as still valid (the API call will surface a 401 if not). */
export function isAccessTokenExpired(
  tokens: OAuthTokens | undefined,
  nowMs: number,
  skewMs = 60_000,
): boolean {
  if (tokens?.accessToken === undefined) return true;
  if (tokens.expiresAt === undefined) return false;
  return nowMs >= tokens.expiresAt - skewMs;
}
