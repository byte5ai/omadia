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

const PROVIDER_KEY_NAMESPACE = 'provider:';
const API_KEY_LEAF = 'api_key';

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
