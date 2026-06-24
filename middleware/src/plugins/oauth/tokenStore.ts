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
