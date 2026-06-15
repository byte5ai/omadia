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
 * single plugin's setup field — currently just the Anthropic API key, whose
 * secret fans out across THREE vault scopes (orchestrator, verifier,
 * orchestrator-extras). Setting it once centrally writes all three; the
 * per-plugin editor would require editing each scope separately.
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
  /** German UI label. */
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

// Category labels (German — the admin section is hardcoded-German, matching
// the sibling admin pages which don't use the i18n catalog).
const C_MODELS = 'Modelle & Routing';

export const SETTINGS_CATALOG: readonly SettingDef[] = [
  // ── Modelle & Routing — cross-plugin secret only ────────────────────────
  // Everything else that used to live here (orchestrator/verifier/embeddings/
  // knowledge-graph/diagrams/integration settings) is now edited per-plugin via
  // the runtime editor, driven by each plugin's manifest setup.fields.
  {
    key: 'ANTHROPIC_API_KEY',
    label: 'Anthropic API-Key',
    help: 'Wird für Orchestrator, Verifier und die Background-Tasks benötigt. Beginnt mit "sk-ant-". Bestehender Wert wird nie angezeigt. Wird zentral in alle drei Plugin-Vaults geschrieben.',
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
    label: 'OpenAI API-Key',
    help: 'Optional. Für Provider-Auswahl "openai" (pro Plugin via llm_provider). Beginnt mit "sk-". Bestehender Wert wird nie angezeigt. Wird in alle drei Plugin-Vaults geschrieben.',
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
    label: 'Mistral API-Key',
    help: 'Optional. Für Provider-Auswahl "mistral" (pro Plugin via llm_provider). Mistral ist EU-gehostet (Frankreich) — keine Drittlandübermittlung. Bestehender Wert wird nie angezeigt. Wird in alle drei Plugin-Vaults geschrieben.',
    category: C_MODELS,
    type: 'secret',
    placeholder: 'API-Key aus console.mistral.ai …',
    secret: {
      // Mistral is canonical-only (no legacy flat key), like OpenAI.
      vaultKey: providerApiKeyVaultKey('mistral'),
      scopes: [ORCHESTRATOR, VERIFIER, ORCHESTRATOR_EXTRAS],
    },
  },
];

/** Provider ids already covered by the static catalog entries above. */
const STATIC_PROVIDER_IDS = new Set(['anthropic', 'openai']);

/** Build per-provider API-key settings for plugin-contributed providers (e.g.
 *  MiniMax) so the operator connects them on the same admin overview as the
 *  built-in keys. The secret fans out to the same three LLM-plugin scopes.
 *  Providers already covered statically (anthropic/openai) are skipped. */
export function providerKeySettings(
  providers: ReadonlyArray<{ readonly id: string; readonly label: string }>,
): SettingDef[] {
  const seen = new Set<string>();
  const out: SettingDef[] = [];
  for (const p of providers) {
    if (STATIC_PROVIDER_IDS.has(p.id) || seen.has(p.id)) continue;
    seen.add(p.id);
    out.push({
      key: `${p.id.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`,
      label: `${p.label} API-Key`,
      help: `Optional. Für Provider-Auswahl "${p.id}" (pro Plugin via llm_provider). Bestehender Wert wird nie angezeigt. Wird in alle drei Plugin-Vaults geschrieben.`,
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
  providers: ReadonlyArray<{ readonly id: string; readonly label: string }> = [],
): readonly SettingDef[] {
  return [...SETTINGS_CATALOG, ...providerKeySettings(providers)];
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
