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
 * moves those copies into the kernel scope once per boot. It is idempotent: a
 * module scope that holds no provider API key is left alone, so the second run
 * changes nothing. It never loses a secret: a copy that DIFFERS from the
 * kernel's key is renamed aside (`superseded:<key>`, still in the vault, no
 * longer read) rather than deleted, and only key names are logged.
 */

import {
  legacyProviderApiKeyVaultKey,
  providerApiKeyVaultKey,
  readProviderApiKey,
} from '@omadia/llm-provider';

/** The vault scope the kernel provider pool reads provider API keys from. */
export const KERNEL_PROVIDER_CREDENTIAL_SCOPE = '@omadia/orchestrator';

/** System modules whose own scope held provider API keys before ADR-0215. */
export const LEGACY_PROVIDER_CREDENTIAL_SCOPES: readonly string[] = [
  '@omadia/verifier',
  '@omadia/orchestrator-extras',
];

/** Prefix a conflicting legacy copy is renamed to; never read as a credential. */
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

/** Every vault key name a provider's API key may be stored under. */
function apiKeyNamesOf(providerId: string): string[] {
  const legacy = legacyProviderApiKeyVaultKey(providerId);
  return legacy === undefined
    ? [providerApiKeyVaultKey(providerId)]
    : [providerApiKeyVaultKey(providerId), legacy];
}

/** The subset of `SecretVault` the consolidation needs. */
export interface CredentialVault {
  get(scope: string, key: string): Promise<string | undefined>;
  setMany(scope: string, entries: Record<string, string>): Promise<void>;
  listKeys(scope: string): Promise<string[]>;
  deleteKey(scope: string, key: string): Promise<void>;
}

/** What one consolidation run did, by key name only. */
export interface ConsolidationReport {
  /** `<scope>/<provider>`: copied into the kernel scope, which had no key. */
  readonly moved: readonly string[];
  /** `<scope>/<provider>`: identical to the kernel's key, copy removed. */
  readonly deduplicated: readonly string[];
  /** `<scope>/<provider>`: differed from the kernel's key, renamed aside. */
  readonly superseded: readonly string[];
}

type Outcome = 'moved' | 'deduplicated' | 'superseded';

async function presentKeys(
  vault: CredentialVault,
  scope: string,
  providerId: string,
): Promise<Array<{ key: string; value: string }>> {
  const out: Array<{ key: string; value: string }> = [];
  for (const key of apiKeyNamesOf(providerId)) {
    const value = await vault.get(scope, key);
    if (value !== undefined) out.push({ key, value });
  }
  return out;
}

async function consolidateOne(
  vault: CredentialVault,
  scope: string,
  providerId: string,
): Promise<Outcome | undefined> {
  const read = (s: string) => (k: string) => vault.get(s, k);
  const moduleKey = await readProviderApiKey(read(scope), providerId);
  const stored = await presentKeys(vault, scope, providerId);
  if (moduleKey === undefined) {
    // Only blank values: nothing to keep, drop the empty names.
    for (const { key } of stored) await vault.deleteKey(scope, key);
    return undefined;
  }
  const kernelKey = await readProviderApiKey(read(KERNEL_PROVIDER_CREDENTIAL_SCOPE), providerId);
  let outcome: Outcome;
  if (kernelKey === undefined) {
    await vault.setMany(KERNEL_PROVIDER_CREDENTIAL_SCOPE, {
      [providerApiKeyVaultKey(providerId)]: moduleKey,
    });
    outcome = 'moved';
  } else if (kernelKey === moduleKey) {
    outcome = 'deduplicated';
  } else {
    // Renamed before the delete below, so the value is never only in memory.
    await vault.setMany(
      scope,
      Object.fromEntries(stored.map(({ key, value }) => [`${SUPERSEDED_KEY_PREFIX}${key}`, value])),
    );
    outcome = 'superseded';
  }
  for (const { key } of stored) await vault.deleteKey(scope, key);
  return outcome;
}

/**
 * Move every provider API key of the legacy system-module scopes into the
 * kernel scope (see the module comment). Safe to run on every boot.
 */
export async function consolidateProviderCredentials(
  vault: CredentialVault,
  log: (message: string) => void = (m) => console.log(m),
): Promise<ConsolidationReport> {
  const report: Record<Outcome, string[]> = { moved: [], deduplicated: [], superseded: [] };
  for (const scope of LEGACY_PROVIDER_CREDENTIAL_SCOPES) {
    const providers = new Set(
      (await vault.listKeys(scope))
        .map(providerOfApiKeyVaultKey)
        .filter((id): id is string => id !== undefined),
    );
    for (const providerId of providers) {
      const outcome = await consolidateOne(vault, scope, providerId);
      if (outcome !== undefined) report[outcome].push(`${scope}/${providerId}`);
    }
  }
  if (report.moved.length > 0) {
    log(`[vault] provider keys moved into ${KERNEL_PROVIDER_CREDENTIAL_SCOPE} (ADR-0215): ${report.moved.join(', ')}`);
  }
  if (report.deduplicated.length > 0) {
    log(`[vault] duplicate provider keys removed from system-module scopes (ADR-0215): ${report.deduplicated.join(', ')}`);
  }
  if (report.superseded.length > 0) {
    log(
      `[vault] WARNING: provider keys that differ from the LLM access key were renamed to '${SUPERSEDED_KEY_PREFIX}<key>' and are no longer read (ADR-0215): ${report.superseded.join(', ')} — enter the key under LLM access if it should be used`,
    );
  }
  return report;
}
