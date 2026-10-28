/**
 * #1468 — a provider's credentials leave with the provider.
 *
 * A provider plugin's key does not live in the plugin's own vault namespace:
 * the settings page and `verify` write `provider:<id>/api_key`,
 * `provider:<id>/verified_at` (and, for OAuth providers, the
 * `provider:<id>/oauth_*` leaves) into the three LLM plugin scopes. Uninstall
 * purged only the plugin's namespace, so those leaves outlived it: a reinstall
 * under the same id silently inherited the key, and with the provider gone no
 * settings field existed to remove it.
 *
 * The caller decides WHETHER to purge — only on a real uninstall, and only
 * when no provider of that id is left in the catalog (a plugin that shadowed a
 * bundled id shares the bundled provider's key, #1451). This module only knows
 * WHAT to purge.
 */

import type { SecretVault } from '../secrets/vault.js';

/** Every vault scope a provider credential is written to (see
 *  `providerKeySettings` in settingsCatalog.ts and the OAuth token binding). */
export const LLM_CREDENTIAL_SCOPES: readonly string[] = [
  '@omadia/orchestrator',
  '@omadia/verifier',
  '@omadia/orchestrator-extras',
];

/**
 * Why `providerId`'s stored credentials must NOT be purged although the plugin
 * that contributed it is being uninstalled, or `undefined` when they may be.
 *
 *  - a built-in id (bundled or experimental, whatever the feature flag says):
 *    the built-in provider owns that key (#1451);
 *  - another installed plugin declares the same `llm_provider.id`: the key is
 *    still that plugin's — the catalog keeps no owner per entry, so the
 *    uninstalled plugin cannot be taken as the owner.
 */
export function providerCredentialPurgeBlocker(
  providerId: string,
  opts: {
    readonly builtinIds: ReadonlySet<string>;
    readonly otherPluginsDeclaring: readonly string[];
  },
): string | undefined {
  if (opts.builtinIds.has(providerId)) {
    return `'${providerId}' is a built-in provider id`;
  }
  if (opts.otherPluginsDeclaring.length > 0) {
    return `still declared by ${opts.otherPluginsDeclaring.join(', ')}`;
  }
  return undefined;
}

/** True for `provider:<providerId>/<leaf>` with a single leaf segment — an
 *  exact namespace match, so purging `foo` never touches `provider:foobar/…`
 *  or a nested `provider:foo/bar/…` belonging to another id. */
export function isProviderCredentialKey(
  vaultKey: string,
  providerId: string,
): boolean {
  const prefix = `provider:${providerId}/`;
  if (!vaultKey.startsWith(prefix)) return false;
  const leaf = vaultKey.slice(prefix.length);
  return leaf.length > 0 && !leaf.includes('/');
}

/**
 * Delete every `provider:<providerId>/*` leaf from the LLM scopes. Best-effort
 * per scope: one unreadable scope must not keep the key in the others, and the
 * uninstall that calls this must complete. Returns the deleted keys as
 * `<scope> <key>` (names only, never a value) for the log.
 */
export async function purgeProviderCredentials(
  vault: Pick<SecretVault, 'listKeys' | 'deleteKey'>,
  providerId: string,
  opts: {
    readonly scopes?: readonly string[];
    readonly onError?: (scope: string, err: unknown) => void;
  } = {},
): Promise<string[]> {
  if (providerId.length === 0 || providerId.includes('/')) return [];
  const removed: string[] = [];
  for (const scope of opts.scopes ?? LLM_CREDENTIAL_SCOPES) {
    try {
      const keys = await vault.listKeys(scope);
      for (const key of keys) {
        if (!isProviderCredentialKey(key, providerId)) continue;
        await vault.deleteKey(scope, key);
        removed.push(`${scope} ${key}`);
      }
    } catch (err) {
      opts.onError?.(scope, err);
    }
  }
  return removed;
}
