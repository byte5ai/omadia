/**
 * Operator-facing catalog of the *cross-plugin* `.env`-based settings exposed in
 * the `/api/v1/admin/settings` admin overview.
 *
 * Historically this catalog mirrored ~every `.env` → plugin-config mapping from
 * `plugins/bootstrap.ts`. That made it a hand-maintained duplicate of each
 * plugin's own `manifest.yaml → setup.fields`, which are already editable
 * through the per-plugin runtime editor (`routes/runtime.ts`). The duplication
 * has been removed: per-plugin settings now live exclusively in that editor.
 *
 * What remains here are only the settings that genuinely DON'T map 1:1 to a
 * single plugin's setup field — the LLM provider API keys, whose secrets fan
 * out across THREE vault scopes (orchestrator, verifier, orchestrator-extras).
 * Setting one centrally writes all three; the per-plugin editor would require
 * editing each scope separately. The web UI edits them under Admin → LLM
 * access → "API keys" (`/admin/providers`); the old `/admin/settings` page that
 * rendered this catalog directly was removed in #1397.
 *
 * The admin PATCH handler still writes config values via
 * `installedRegistry.updateConfig` and secrets via `vault.setMany` /
 * `deleteKey`, then `reactivate`s each affected plugin — the same plumbing the
 * post-install editor uses, so changes take effect live without a restart.
 */

import {
  legacyProviderApiKeyVaultKey,
  providerApiKeyVaultKey,
} from '@omadia/llm-provider';

/** Plugin ids (installed-registry ids / vault scopes) the settings target. */
const ORCHESTRATOR = '@omadia/orchestrator';
const ORCHESTRATOR_EXTRAS = '@omadia/orchestrator-extras';
const VERIFIER = '@omadia/verifier';

export type SettingValueType =
  | 'string'
  | 'url'
  | 'number'
  | 'boolean'
  | 'enum'
  | 'secret';

export interface SettingDef {
  /** Stable identifier — the `.env` variable name. Also the GET/PATCH key. */
  readonly key: string;
  /** Field label. English: the API carries no locale (see `errorHelp.ts` in
   *  web-ui); the admin UI renders provider keys from its own catalog. */
  readonly label: string;
  /** Optional help text shown under the field. */
  readonly help?: string;
  /** Grouping shown as a section in the admin overview. */
  readonly category: string;
  readonly type: SettingValueType;
  /** Options for `type === 'enum'`. */
  readonly options?: ReadonlyArray<{ value: string; label: string }>;
  /** Input placeholder / shown default hint. */
  readonly placeholder?: string;
  /**
   * Target for NON-secret settings: the installed plugin whose `config[<key>]`
   * holds the value. Exactly one of `config` / `secret` is set.
   */
  readonly config?: { readonly pluginId: string; readonly configKey: string };
  /**
   * Target for SECRET settings: the vault key, written into every listed
   * scope (a secret like the Anthropic key is read by several plugins, each
   * under its own vault namespace). Values are never read back — the overview
   * only shows set / unset.
   */
  readonly secret?: {
    readonly vaultKey: string;
    readonly scopes: readonly string[];
    /**
     * A pre-migration vault key that `readProviderApiKey` still falls back to.
     * Set so that CLEARING the secret also deletes the legacy key — otherwise a
     * cleared key keeps resolving via the fallback and the operator's revoke is
     * silently ineffective.
     */
    readonly legacyVaultKey?: string;
  };
}

// Category label. The web UI no longer renders this overview (#1397: provider
// keys are managed under Admin → LLM access), so it is plain English like every
// other string this API returns.
const C_MODELS = 'Models & routing';

export const SETTINGS_CATALOG: readonly SettingDef[] = [
  // ── Models & routing — cross-plugin secret only ────────────────────────
  // Everything else that used to live here (orchestrator/verifier/embeddings/
  // knowledge-graph/diagrams/integration settings) is now edited per-plugin via
  // the runtime editor, driven by each plugin's manifest setup.fields.
  {
    key: 'ANTHROPIC_API_KEY',
    label: 'Anthropic API key',
    help: 'Used by the orchestrator, the verifier and the background tasks. Starts with "sk-ant-". The stored value is never shown. Written to all three plugin vaults.',
    category: C_MODELS,
    type: 'secret',
    placeholder: 'sk-ant-…',
    secret: {
      // Phase 4: writes the provider-namespaced canonical key. Consumers read
      // canonical-then-legacy, and bootstrap migrates existing installs, so the
      // overview "set/unset" + admin writes converge on this key. The legacy key
      // is deleted on clear (see adminSettings) so a revoke truly revokes.
      vaultKey: providerApiKeyVaultKey('anthropic'),
      legacyVaultKey: legacyProviderApiKeyVaultKey('anthropic'),
      scopes: [ORCHESTRATOR, VERIFIER, ORCHESTRATOR_EXTRAS],
    },
  },
  {
    key: 'OPENAI_API_KEY',
    label: 'OpenAI API key',
    help: 'Optional. For the provider "openai" (chosen per plugin via llm_provider). Starts with "sk-". The stored value is never shown. Written to all three plugin vaults.',
    category: C_MODELS,
    type: 'secret',
    placeholder: 'sk-…',
    secret: {
      // OpenAI is canonical-only (no legacy flat key).
      vaultKey: providerApiKeyVaultKey('openai'),
      scopes: [ORCHESTRATOR, VERIFIER, ORCHESTRATOR_EXTRAS],
    },
  },
  {
    key: 'MISTRAL_API_KEY',
    label: 'Mistral API key',
    help: 'Optional. For the provider "mistral" (chosen per plugin via llm_provider). Mistral is hosted in the EU (France), so there is no third-country transfer. The stored value is never shown. Written to all three plugin vaults.',
    category: C_MODELS,
    type: 'secret',
    placeholder: 'API key from console.mistral.ai …',
    secret: {
      // Mistral is canonical-only (no legacy flat key), like OpenAI.
      vaultKey: providerApiKeyVaultKey('mistral'),
      scopes: [ORCHESTRATOR, VERIFIER, ORCHESTRATOR_EXTRAS],
    },
  },
];

/** Vault keys the static entries above already write. A provider whose own
 *  key (`providerApiKeyVaultKey(id)`) is one of them is covered there, so it
 *  gets no generated field. Derived from the catalog instead of kept as a
 *  second hand-maintained id list: that list once read `['anthropic',
 *  'openai']` while the catalog also held Mistral, and Mistral got a second
 *  `MISTRAL_API_KEY` field (#1331). */
const STATIC_VAULT_KEYS: ReadonlySet<string> = new Set(
  SETTINGS_CATALOG.flatMap((def) => (def.secret ? [def.secret.vaultKey] : [])),
);

/** What `providerKeySettings` needs to know about a registered provider. */
export interface ProviderKeySource {
  readonly id: string;
  readonly label: string;
  readonly policy?: { readonly requiresApiKey?: boolean };
  /** `'claude-cli'` — the subscription CLI, signed in via `claude auth login`. */
  readonly wireFormat?: string;
  /** Present when the provider connects through an OAuth sign-in (ChatGPT). */
  readonly oauth?: unknown;
}

/**
 * A provider that is keyless AND signs in some other way — the subscription
 * CLI or an OAuth connect — gets no key field: it would ask for a key nothing
 * reads (#1331). A keyless provider WITHOUT another sign-in (a local model
 * server) keeps its optional field, because the provider factory still sends a
 * stored key when there is one (e.g. Ollama behind an auth proxy), and the LLM
 * access page offers the same optional key.
 */
function signsInWithoutKey(p: ProviderKeySource): boolean {
  if (p.policy?.requiresApiKey !== false) return false;
  return p.wireFormat === 'claude-cli' || p.oauth !== undefined;
}

/** Build per-provider API-key settings for plugin-contributed providers (e.g.
 *  MiniMax) so the operator connects them on the same admin overview as the
 *  built-in keys. The secret fans out to the same three LLM-plugin scopes.
 *  Skipped: providers the static entries already cover, and providers that
 *  sign in without a key (see `signsInWithoutKey`). */
export function providerKeySettings(
  providers: ReadonlyArray<ProviderKeySource>,
): SettingDef[] {
  const seen = new Set<string>();
  const out: SettingDef[] = [];
  for (const p of providers) {
    if (seen.has(p.id)) continue;
    if (STATIC_VAULT_KEYS.has(providerApiKeyVaultKey(p.id))) continue;
    if (signsInWithoutKey(p)) continue;
    seen.add(p.id);
    out.push({
      key: `${p.id.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`,
      label: `${p.label} API key`,
      help: `Optional. For the provider "${p.id}" (chosen per plugin via llm_provider). The stored value is never shown. Written to all three plugin vaults.`,
      category: C_MODELS,
      type: 'secret',
      secret: {
        vaultKey: providerApiKeyVaultKey(p.id),
        scopes: [ORCHESTRATOR, VERIFIER, ORCHESTRATOR_EXTRAS],
      },
    });
  }
  return out;
}

/** The effective catalog: static cross-plugin settings + per-provider API-key
 *  settings for plugin-contributed providers. */
export function buildSettingsCatalog(
  providers: ReadonlyArray<ProviderKeySource> = [],
): readonly SettingDef[] {
  // Keys are the GET/PATCH identity, so the first definition of a key wins.
  // Two providers whose ids normalise to the same `<ID>_API_KEY` (say `foo-bar`
  // and `foo_bar`) would otherwise render two fields writing different vault
  // keys under one name.
  const seen = new Set<string>();
  return [...SETTINGS_CATALOG, ...providerKeySettings(providers)].filter(
    (def) => {
      if (seen.has(def.key)) return false;
      seen.add(def.key);
      return true;
    },
  );
}

/** Lookup by `.env` key over a given catalog (defaults to the static one). */
export function findSetting(
  key: string,
  catalog: readonly SettingDef[] = SETTINGS_CATALOG,
): SettingDef | undefined {
  return catalog.find((s) => s.key === key);
}

/** Distinct plugin ids a setting touches (config plugin + all secret scopes). */
export function settingPluginIds(def: SettingDef): string[] {
  if (def.config) return [def.config.pluginId];
  if (def.secret) return [...def.secret.scopes];
  return [];
}

/** Category order for stable rendering in the admin overview. */
export const SETTINGS_CATEGORY_ORDER: readonly string[] = [C_MODELS];
