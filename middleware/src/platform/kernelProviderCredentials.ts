/**
 * #2240 / ADR-0215 — provider API keys live in ONE vault scope, the kernel's.
 *
 * The kernel provider pool (`llmProviderPool@1`, `src/index.ts`) reads the
 * scope `@omadia/orchestrator`; the scope keeps that id because every reader
 * (provider readiness, model discovery, the ChatGPT token store, the shared
 * Anthropic client, the mirrored keys of the canvas and fast-path plugins)
 * already reads it, and renaming it would move every credential of every
 * install. The orchestrator, the verifier and orchestrator-extras build their
 * providers from that pool only.
 *
 * Before ADR-0215 the LLM access page wrote each key into three scopes and the
 * verifier and extras read their own copy. {@link consolidateProviderCredentials}
 * clears those copies once per boot, key name by key name:
 *
 *   - a copy equal to the kernel's key for that provider is deleted;
 *   - every other copy — a different key, or a key the kernel scope does not
 *     hold at all — is renamed aside (`superseded:<key>`, a numbered suffix if
 *     that name is taken). It stays in the vault and nothing reads it. A key
 *     only a module held is deliberately NOT promoted into the kernel scope:
 *     that would widen which providers the whole instance can reach without
 *     the operator entering the key under LLM access (ADR-0084 posture). The
 *     boot log asks the operator to do that.
 *
 * Idempotent: a module scope without provider API keys is left alone, so the
 * second run changes nothing. Only key names reach the log.
 */

import {
  legacyProviderApiKeyVaultKey,
  readProviderApiKey,
} from '@omadia/llm-provider';

/** The vault scope the kernel provider pool reads provider API keys from. */
export const KERNEL_PROVIDER_CREDENTIAL_SCOPE = '@omadia/orchestrator';

/** System modules whose own scope held provider API keys before ADR-0215. */
export const LEGACY_PROVIDER_CREDENTIAL_SCOPES: readonly string[] = [
  '@omadia/verifier',
  '@omadia/orchestrator-extras',
];

/** Prefix a legacy copy is renamed to; never read as a credential. */
export const SUPERSEDED_KEY_PREFIX = 'superseded:';

const CANONICAL_API_KEY = /^provider:([^/]+)\/api_key$/;
const LEGACY_ANTHROPIC_API_KEY = legacyProviderApiKeyVaultKey('anthropic');

/** The provider a vault key holds the API key of, or `undefined`. */
export function providerOfApiKeyVaultKey(key: string): string | undefined {
  if (key === LEGACY_ANTHROPIC_API_KEY) return 'anthropic';
  return CANONICAL_API_KEY.exec(key)?.[1];
}

/** True for a provider API key name (canonical or the legacy Anthropic one). */
export function isProviderApiKeyVaultKey(key: string): boolean {
  return providerOfApiKeyVaultKey(key) !== undefined;
}

/** True when `key` is a superseded copy of `original` (`superseded:<original>` or `…#<n>`). */
export function isSupersededCopyOf(key: string, original: string): boolean {
  const base = `${SUPERSEDED_KEY_PREFIX}${original}`;
  return key === base || (key.startsWith(`${base}#`) && /^\d+$/.test(key.slice(base.length + 1)));
}

/** The first free `superseded:` name for `original` in `taken`. */
function supersededNameFor(original: string, taken: ReadonlySet<string>): string {
  const base = `${SUPERSEDED_KEY_PREFIX}${original}`;
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}#${String(n)}`)) n += 1;
  return `${base}#${String(n)}`;
}

/** The subset of `SecretVault` the consolidation needs. */
export interface CredentialVault {
  get(scope: string, key: string): Promise<string | undefined>;
  setMany(scope: string, entries: Record<string, string>): Promise<void>;
  listKeys(scope: string): Promise<string[]>;
  deleteKey(scope: string, key: string): Promise<void>;
}

/** What one consolidation run did, as `<scope>/<key name>` — never a value. */
export interface ConsolidationReport {
  /** Equal to the kernel's key for the provider: deleted. */
  readonly deduplicated: readonly string[];
  /** Different from the kernel's key, or the kernel has none: renamed aside. */
  readonly superseded: readonly string[];
}

async function consolidateScope(
  vault: CredentialVault,
  scope: string,
  report: { deduplicated: string[]; superseded: string[] },
): Promise<void> {
  const keys = await vault.listKeys(scope);
  const taken = new Set(keys);
  const kernelKeys = new Map<string, string | undefined>();
  const kernelKeyOf = async (providerId: string): Promise<string | undefined> => {
    if (!kernelKeys.has(providerId)) {
      kernelKeys.set(
        providerId,
        await readProviderApiKey((k) => vault.get(KERNEL_PROVIDER_CREDENTIAL_SCOPE, k), providerId),
      );
    }
    return kernelKeys.get(providerId);
  };
  for (const key of keys) {
    const providerId = providerOfApiKeyVaultKey(key);
    if (providerId === undefined) continue;
    const value = (await vault.get(scope, key)) ?? '';
    if (value.trim().length === 0) {
      await vault.deleteKey(scope, key);
      continue;
    }
    if (value.trim() === (await kernelKeyOf(providerId))) {
      report.deduplicated.push(`${scope}/${key}`);
    } else {
      // Written before the delete below, so the value is never only in memory.
      const aside = supersededNameFor(key, taken);
      await vault.setMany(scope, { [aside]: value });
      taken.add(aside);
      report.superseded.push(`${scope}/${key}`);
    }
    await vault.deleteKey(scope, key);
  }
}

/**
 * Clear every provider API key out of the legacy system-module scopes (see
 * the module comment). Safe to run on every boot.
 */
export async function consolidateProviderCredentials(
  vault: CredentialVault,
  log: (message: string) => void = (m) => console.log(m),
): Promise<ConsolidationReport> {
  const report = { deduplicated: [] as string[], superseded: [] as string[] };
  for (const scope of LEGACY_PROVIDER_CREDENTIAL_SCOPES) {
    await consolidateScope(vault, scope, report);
  }
  if (report.deduplicated.length > 0) {
    log(`[vault] duplicate provider keys removed from system-module scopes (ADR-0215): ${report.deduplicated.join(', ')}`);
  }
  if (report.superseded.length > 0) {
    log(
      `[vault] WARNING: provider keys held only by a system module, or differing from the key under LLM access, were renamed to '${SUPERSEDED_KEY_PREFIX}<key>' and are no longer read (ADR-0215): ${report.superseded.join(', ')} — enter the key under Admin → LLM access if it should be used`,
    );
  }
  return report;
}

/**
 * The superseded copies of `originals` left in the legacy scopes — what a
 * revoke or a provider uninstall must delete as well, so no copy of a revoked
 * key stays behind.
 */
export async function deleteSupersededCopies(
  vault: Pick<CredentialVault, 'listKeys' | 'deleteKey'>,
  originals: readonly string[],
): Promise<string[]> {
  const removed: string[] = [];
  for (const scope of LEGACY_PROVIDER_CREDENTIAL_SCOPES) {
    for (const key of await vault.listKeys(scope)) {
      if (!originals.some((o) => isSupersededCopyOf(key, o))) continue;
      await vault.deleteKey(scope, key);
      removed.push(`${scope} ${key}`);
    }
  }
  return removed;
}
