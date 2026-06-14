/**
 * OAuth 2.0 Device Authorization Grant (RFC 8628) for "Sign in with ChatGPT"
 * (phase 4b — EXPERIMENTAL). Lets an operator connect a provider via their
 * ChatGPT subscription instead of pasting an API key: the device flow yields an
 * access + refresh token that are stored in the vault and refreshed on demand.
 *
 * ⚠️ EXPERIMENTAL / ToS GREY AREA. Using a ChatGPT-subscription login to drive
 * programmatic API calls lives in a grey area of OpenAI's terms — surface a
 * clear notice in the UI and do not market it as an enterprise feature. The
 * token's audience is OpenAI's Codex/ChatGPT backend, NOT necessarily the
 * standard `api.openai.com` Chat Completions surface; wiring it to a provider
 * therefore needs the correct `baseURL` (and possibly a Responses-API shim).
 * That end-to-end binding + a live ChatGPT login are required to verify it
 * actually serves requests — this module only owns the (pure, testable) token
 * lifecycle.
 *
 * Endpoints + client id are the OpenAI Codex public client (reviewed 2026-06-14;
 * see help.openai.com/en/articles/11381614, developers.openai.com/codex/auth).
 * The device-authorization endpoint is best-effort and MUST be confirmed against
 * a live flow before shipping — every function takes its config + a `fetch`
 * implementation so tests never depend on the live endpoints.
 */

/** OpenAI Codex public OAuth client configuration. */
export interface OAuthClientConfig {
  readonly clientId: string;
  /** RFC 8628 device authorization endpoint (request device + user codes). */
  readonly deviceAuthorizationEndpoint: string;
  /** Token endpoint (device-code polling + refresh). */
  readonly tokenEndpoint: string;
  /** Human verification URL shown to the operator. */
  readonly verificationUri: string;
  readonly scope: string;
}

/** Default OpenAI Codex client. `deviceAuthorizationEndpoint` is best-effort —
 *  confirm against a live `codex login --device-auth` before relying on it. */
export const OPENAI_CODEX_OAUTH: OAuthClientConfig = {
  clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
  deviceAuthorizationEndpoint: 'https://auth.openai.com/oauth/device/code',
  tokenEndpoint: 'https://auth.openai.com/oauth/token',
  verificationUri: 'https://auth.openai.com/codex/device',
  scope: 'openid profile email offline_access',
};

export interface DeviceCodeGrant {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly verificationUri: string;
  /** Combined URL with the code pre-filled, when the server returns it. */
  readonly verificationUriComplete?: string;
  /** Seconds until the device code expires. */
  readonly expiresIn: number;
  /** Minimum seconds between token polls. */
  readonly interval: number;
}

export interface OAuthTokens {
  readonly accessToken: string;
  readonly refreshToken?: string;
  /** Absolute epoch-ms expiry, computed from the grant's `expires_in`. */
  readonly expiresAt?: number;
  readonly tokenType?: string;
  readonly idToken?: string;
}

/** Outcome of a single token poll during the device flow. */
export type PollResult =
  | { readonly status: 'complete'; readonly tokens: OAuthTokens }
  | { readonly status: 'pending' }
  /** Server asked us to back off — caller should increase the interval. */
  | { readonly status: 'slow_down' }
  | { readonly status: 'expired' }
  | { readonly status: 'denied' };

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

function toTokens(body: unknown, nowMs: number): OAuthTokens {
  const b = asRecord(body);
  const accessToken = str(b['access_token']);
  if (accessToken === undefined) {
    throw new Error('oauth: token response missing access_token');
  }
  const expiresIn = num(b['expires_in']);
  return {
    accessToken,
    ...(str(b['refresh_token']) !== undefined
      ? { refreshToken: str(b['refresh_token']) }
      : {}),
    ...(expiresIn !== undefined ? { expiresAt: nowMs + expiresIn * 1000 } : {}),
    ...(str(b['token_type']) !== undefined ? { tokenType: str(b['token_type']) } : {}),
    ...(str(b['id_token']) !== undefined ? { idToken: str(b['id_token']) } : {}),
  };
}

/** Step 1 — request a device + user code. The operator then visits
 *  `verificationUri` and enters `userCode`. */
export async function requestDeviceCode(
  fetchImpl: FetchLike,
  config: OAuthClientConfig,
): Promise<DeviceCodeGrant> {
  const res = await fetchImpl(config.deviceAuthorizationEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form({ client_id: config.clientId, scope: config.scope }),
  });
  if (!res.ok) {
    throw new Error(`oauth: device authorization failed (${String(res.status)})`);
  }
  const b = asRecord(await res.json());
  const deviceCode = str(b['device_code']);
  const userCode = str(b['user_code']);
  if (deviceCode === undefined || userCode === undefined) {
    throw new Error('oauth: device authorization response missing codes');
  }
  return {
    deviceCode,
    userCode,
    verificationUri: str(b['verification_uri']) ?? config.verificationUri,
    ...(str(b['verification_uri_complete']) !== undefined
      ? { verificationUriComplete: str(b['verification_uri_complete']) }
      : {}),
    expiresIn: num(b['expires_in']) ?? 900,
    interval: num(b['interval']) ?? 5,
  };
}

/** Step 2 — poll once for the token. RFC 8628 maps the OAuth error codes onto
 *  the poll states; any other error rejects. */
export async function pollDeviceToken(
  fetchImpl: FetchLike,
  config: OAuthClientConfig,
  deviceCode: string,
  nowMs: NowMs,
): Promise<PollResult> {
  const res = await fetchImpl(config.tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form({
      client_id: config.clientId,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: deviceCode,
    }),
  });
  const body = asRecord(await res.json());
  if (res.ok) {
    return { status: 'complete', tokens: toTokens(body, nowMs()) };
  }
  switch (str(body['error'])) {
    case 'authorization_pending':
      return { status: 'pending' };
    case 'slow_down':
      return { status: 'slow_down' };
    case 'expired_token':
      return { status: 'expired' };
    case 'access_denied':
      return { status: 'denied' };
    default:
      throw new Error(`oauth: token poll failed (${String(res.status)}: unknown_oauth_error)`);
  }
}

/** Refresh an expired access token. Returns new tokens; the server may or may
 *  not rotate the refresh token (we keep the old one if it doesn't). */
export async function refreshAccessToken(
  fetchImpl: FetchLike,
  config: OAuthClientConfig,
  refreshToken: string,
  nowMs: NowMs,
): Promise<OAuthTokens> {
  const res = await fetchImpl(config.tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form({
      client_id: config.clientId,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  });
  if (!res.ok) {
    throw new Error(`oauth: token refresh failed (${String(res.status)})`);
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
