/**
 * Spec 005 — persistence for broker-acquired OAuth tokens.
 *
 * The broker callback writes `{access, refresh, expiry, scope}` to the
 * plugin's own vault namespace, keyed by the `type:oauth` field; the
 * `ctx.oauthTokens` accessor reads them back and lazily refreshes. Tokens are
 * stored under an `oauth.<fieldKey>` key so they never collide with the
 * operator-facing setup-field secrets (e.g. `client_secret`) the credentials
 * editor enumerates by bare field key — and so the editor never renders a raw
 * access/refresh token.
 */

import type { SecretVault } from '../../secrets/vault.js';

export interface StoredOAuthTokens {
  accessToken: string;
  /** May be '' when the provider issues none. */
  refreshToken: string;
  /** ISO-8601 absolute expiry. */
  expiresAt: string;
  /** Space-separated granted scopes. */
  scope: string;
}

/** Vault key for a field's token bundle — reserved `oauth.` prefix keeps it
 *  out of the plain setup-field-secret namespace. */
export function oauthVaultKey(fieldKey: string): string {
  return `oauth.${fieldKey}`;
}

/**
 * Issue #474 (review round 10) — the refresh margin `ctx.oauthTokens.get()`
 * (pluginContext.ts) uses to decide whether a stored access token still
 * needs renewing. Exported so `isTokenRefreshable` below can mirror the
 * exact same "expired" definition instead of inventing a second one that
 * could drift from the real consumer's behaviour.
 */
export const OAUTH_REFRESH_MARGIN_MS = 5 * 60 * 1000;

/** True when `stored`'s access token has more than the refresh margin left
 *  before `expiresAt` (an unparseable/missing `expiresAt` counts as NOT
 *  fresh). Shared by pluginContext.ts's `ctx.oauthTokens.get()` (refreshes
 *  when this is false) and `OAuthReadinessTracker` (treats "not fresh AND no
 *  refresh token" as not-ready) so the two can never disagree on what counts
 *  as expired. */
export function isTokenStillFresh(
  stored: Pick<StoredOAuthTokens, 'expiresAt'>,
): boolean {
  const expiresMs = Date.parse(stored.expiresAt);
  return (
    Number.isFinite(expiresMs) && expiresMs - Date.now() > OAUTH_REFRESH_MARGIN_MS
  );
}

/**
 * Issue #474 (review round 10) — true when `stored` can currently produce a
 * usable access token: either it's still fresh, or it's expired but has a
 * refresh token to renew it with (a refresh is expected to succeed
 * transparently). False only when it's expired/unparseable AND has no
 * refresh token — the exact case where `ctx.oauthTokens.get()` throws
 * `OAuthTokenError('refresh_failed')` with no way to recover automatically.
 */
export function isTokenRefreshable(stored: StoredOAuthTokens): boolean {
  return isTokenStillFresh(stored) || stored.refreshToken !== '';
}

export async function writeStoredTokens(
  vault: SecretVault,
  pluginId: string,
  fieldKey: string,
  tokens: StoredOAuthTokens,
): Promise<void> {
  await vault.set(pluginId, oauthVaultKey(fieldKey), JSON.stringify(tokens));
}

export async function readStoredTokens(
  vault: SecretVault,
  pluginId: string,
  fieldKey: string,
): Promise<StoredOAuthTokens | undefined> {
  const raw = await vault.get(pluginId, oauthVaultKey(fieldKey));
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object') return undefined;
  const r = parsed as Record<string, unknown>;
  const accessToken = typeof r['accessToken'] === 'string' ? r['accessToken'] : '';
  if (!accessToken) return undefined;
  return {
    accessToken,
    refreshToken: typeof r['refreshToken'] === 'string' ? r['refreshToken'] : '',
    expiresAt: typeof r['expiresAt'] === 'string' ? r['expiresAt'] : '',
    scope: typeof r['scope'] === 'string' ? r['scope'] : '',
  };
}
