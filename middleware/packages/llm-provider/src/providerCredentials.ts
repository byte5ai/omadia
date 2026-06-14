/**
 * Provider credential vault-key scheme (phase 4 of
 * docs/plans/llm-provider-interface-plan.md).
 *
 * Going-forward, every provider's API key lives under a provider-namespaced
 * vault key: `provider:<id>/api_key` (e.g. `provider:anthropic/api_key`,
 * `provider:openai/api_key`). This replaces the flat, Anthropic-only
 * `anthropic_api_key` key so multiple providers can coexist in one vault scope.
 *
 * SAFETY (hard gate — existing installs must never lose their key): the change
 * is non-destructive. `readProviderApiKey` reads the canonical key first and
 * falls back to the legacy `anthropic_api_key`, and the bootstrap migration
 * COPIES legacy → canonical without deleting the legacy key. So three
 * independent mechanisms converge on the same value: the migration, the env
 * seed (writes canonical), and the legacy fallback. A miss in any one cannot
 * break the Anthropic default path.
 */

import {
  isAccessTokenExpired,
  refreshAccessToken,
  type FetchLike,
  type NowMs,
  type OAuthClientConfig,
  type OAuthTokens,
} from './oauthDeviceFlow.js';

const PROVIDER_KEY_NAMESPACE = 'provider:';
const API_KEY_LEAF = 'api_key';
const OAUTH_ACCESS_LEAF = 'oauth_access_token';
const OAUTH_REFRESH_LEAF = 'oauth_refresh_token';
const OAUTH_EXPIRES_LEAF = 'oauth_expires_at';

/** Canonical vault key for a provider's API key: `provider:anthropic/api_key`. */
export function providerApiKeyVaultKey(providerId: string): string {
  return `${PROVIDER_KEY_NAMESPACE}${providerId}/${API_KEY_LEAF}`;
}

/**
 * Legacy (pre-namespace) vault key retained ONLY as a read fallback so existing
 * installs keep working before/without the migration. Only Anthropic ever had a
 * flat legacy key (`anthropic_api_key`); every other provider is canonical-only.
 */
export function legacyProviderApiKeyVaultKey(
  providerId: string,
): string | undefined {
  return providerId === 'anthropic' ? 'anthropic_api_key' : undefined;
}

/**
 * Read a provider's API key from a vault scope: canonical key first, then the
 * legacy key as a fallback (Anthropic only). Returns the trimmed key, or
 * `undefined` if neither holds a non-empty value.
 *
 * `get` is the scope-bound vault read — e.g. `(k) => ctx.secrets.get(k)` for a
 * plugin, or `(k) => vault.get(agentId, k)` for the kernel.
 */
export async function readProviderApiKey(
  get: (key: string) => Promise<string | undefined>,
  providerId: string,
): Promise<string | undefined> {
  const canonical = (await get(providerApiKeyVaultKey(providerId)))?.trim();
  if (canonical !== undefined && canonical.length > 0) return canonical;
  const legacyKey = legacyProviderApiKeyVaultKey(providerId);
  if (legacyKey !== undefined) {
    const legacy = (await get(legacyKey))?.trim();
    if (legacy !== undefined && legacy.length > 0) return legacy;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// OAuth tokens (phase 4b — "Sign in with ChatGPT"). Stored alongside the
// api_key under the same provider namespace so a provider can be connected
// either way. EXPERIMENTAL — see oauthDeviceFlow.ts for the ToS/audience caveat.
// ---------------------------------------------------------------------------

/** Canonical vault keys for a provider's OAuth tokens. */
export function providerOAuthVaultKeys(providerId: string): {
  access: string;
  refresh: string;
  expiresAt: string;
} {
  const base = `${PROVIDER_KEY_NAMESPACE}${providerId}`;
  return {
    access: `${base}/${OAUTH_ACCESS_LEAF}`,
    refresh: `${base}/${OAUTH_REFRESH_LEAF}`,
    expiresAt: `${base}/${OAUTH_EXPIRES_LEAF}`,
  };
}

/** Read a provider's stored OAuth tokens, or `undefined` when no access token
 *  is present. `get` is the scope-bound vault read. */
export async function readProviderOAuthTokens(
  get: (key: string) => Promise<string | undefined>,
  providerId: string,
): Promise<OAuthTokens | undefined> {
  const keys = providerOAuthVaultKeys(providerId);
  const accessToken = (await get(keys.access))?.trim();
  if (accessToken === undefined || accessToken.length === 0) return undefined;
  const refreshToken = (await get(keys.refresh))?.trim();
  const expiresRaw = (await get(keys.expiresAt))?.trim();
  const expiresAt =
    expiresRaw !== undefined && expiresRaw.length > 0
      ? Number.parseInt(expiresRaw, 10)
      : undefined;
  return {
    accessToken,
    ...(refreshToken !== undefined && refreshToken.length > 0
      ? { refreshToken }
      : {}),
    ...(expiresAt !== undefined && Number.isFinite(expiresAt) ? { expiresAt } : {}),
  };
}

/** Persist a provider's OAuth tokens. `set` is the scope-bound vault write.
 *  Optional fields are blanked when absent so stale refresh/expiry values do not
 *  survive a later rewrite and get read back as current tokens. */
export async function writeProviderOAuthTokens(
  set: (key: string, value: string) => Promise<void>,
  providerId: string,
  tokens: OAuthTokens,
): Promise<void> {
  const keys = providerOAuthVaultKeys(providerId);
  await set(keys.access, tokens.accessToken);
  if (tokens.refreshToken !== undefined) {
    await set(keys.refresh, tokens.refreshToken);
  } else {
    await set(keys.refresh, '');
  }
  if (tokens.expiresAt !== undefined) {
    await set(keys.expiresAt, String(tokens.expiresAt));
  } else {
    await set(keys.expiresAt, '');
  }
}

export interface ResolveOAuthBearerOptions {
  readonly get: (key: string) => Promise<string | undefined>;
  readonly set: (key: string, value: string) => Promise<void>;
  readonly providerId: string;
  readonly fetchImpl: FetchLike;
  readonly config: OAuthClientConfig;
  readonly nowMs: NowMs;
}

/**
 * Resolve a usable OAuth access token for a provider, refreshing it first when
 * it is expired (and a refresh token is available) and persisting the rotated
 * tokens. Returns `undefined` when the provider has no stored OAuth tokens, so
 * the caller falls back to the api_key path. When the token is expired but no
 * refresh token is stored, the (likely-dead) access token is returned anyway so
 * the downstream 401 surfaces the real problem rather than masking it.
 */
export async function resolveProviderOAuthBearer(
  opts: ResolveOAuthBearerOptions,
): Promise<string | undefined> {
  const tokens = await readProviderOAuthTokens(opts.get, opts.providerId);
  if (tokens === undefined) return undefined;
  if (!isAccessTokenExpired(tokens, opts.nowMs())) return tokens.accessToken;
  if (tokens.refreshToken === undefined) return tokens.accessToken;
  const refreshed = await refreshAccessToken(
    opts.fetchImpl,
    opts.config,
    tokens.refreshToken,
    opts.nowMs,
  );
  await writeProviderOAuthTokens(opts.set, opts.providerId, refreshed);
  return refreshed.accessToken;
}
