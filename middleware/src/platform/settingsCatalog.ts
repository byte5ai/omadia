/**
 * Operator-facing catalog of the `.env`-based settings that get written into
 * the runtime config-store / secret vault on first boot (see
 * `plugins/bootstrap.ts`). This is the single source of truth behind the
 * `/api/v1/admin/settings` admin overview: each entry knows its human label,
 * category, value type, and — crucially — WHERE the value lives at runtime
 * (which installed plugin's config key, or which vault scope+key for secrets).
 *
 * Why a curated catalog rather than deriving from each plugin's setup_schema:
 * the `.env` → config mappings in bootstrap are broader than the install
 * wizard's setup_schema (e.g. model-routing flags, max-tokens) and we want a
 * grouped, operator-readable overview of exactly those env-seeded values —
 * not every internal config key. Keeping it as plain data also makes it
 * trivially testable and lets the admin page render generic typed inputs.
 *
 * The admin PATCH handler writes config values via
 * `installedRegistry.updateConfig` and secrets via `vault.setMany` /
 * `deleteKey`, then `reactivate`s each affected plugin — the same plumbing the
 * post-install editor (`routes/runtime.ts`) already uses, so changes take
 * effect live ("auto change nach Änderung") without a restart.
 */

/** Plugin ids (installed-registry ids / vault scopes) the settings target. */
const ORCHESTRATOR = '@omadia/orchestrator';
const ORCHESTRATOR_EXTRAS = '@omadia/orchestrator-extras';
const VERIFIER = '@omadia/verifier';
const EMBEDDINGS = '@omadia/embeddings';
const KNOWLEDGE_GRAPH = '@omadia/knowledge-graph-neon';
const DIAGRAMS = '@omadia/diagrams';
const MICROSOFT365 = 'de.byte5.integration.microsoft365';
const TEAMS = 'de.byte5.channel.teams';
const TELEGRAM = 'de.byte5.channel.telegram';

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
  readonly secret?: { readonly vaultKey: string; readonly scopes: readonly string[] };
}

// Category labels (German — the admin section is hardcoded-German, matching
// the sibling admin pages which don't use the i18n catalog).
const C_MODELS = 'Modelle & Routing';
const C_VERIFIER = 'Verifier';
const C_KNOWLEDGE = 'Wissen & Embeddings';
const C_DIAGRAMS = 'Diagramme & Speicher';
const C_INTEGRATIONS = 'Integrationen';

export const SETTINGS_CATALOG: readonly SettingDef[] = [
  // ── Modelle & Routing (@omadia/orchestrator) ────────────────────────────
  {
    key: 'ANTHROPIC_API_KEY',
    label: 'Anthropic API-Key',
    help: 'Wird für Orchestrator, Verifier und die Background-Tasks benötigt. Beginnt mit "sk-ant-". Bestehender Wert wird nie angezeigt.',
    category: C_MODELS,
    type: 'secret',
    placeholder: 'sk-ant-…',
    secret: {
      vaultKey: 'anthropic_api_key',
      scopes: [ORCHESTRATOR, VERIFIER, ORCHESTRATOR_EXTRAS],
    },
  },
  {
    key: 'ORCHESTRATOR_MODEL',
    label: 'Orchestrator-Modell',
    help: 'Standard-Modell für jeden Chat-Turn (z. B. claude-opus-4-8). Bei aktivem Routing der "complex"-Fallback.',
    category: C_MODELS,
    type: 'string',
    placeholder: 'claude-opus-4-8',
    config: { pluginId: ORCHESTRATOR, configKey: 'orchestrator_model' },
  },
  {
    key: 'ORCHESTRATOR_MAX_TOKENS',
    label: 'Orchestrator max. Tokens',
    category: C_MODELS,
    type: 'number',
    placeholder: '8192',
    config: { pluginId: ORCHESTRATOR, configKey: 'orchestrator_max_tokens' },
  },
  {
    key: 'MAX_TOOL_ITERATIONS',
    label: 'Max. Tool-Iterationen pro Turn',
    category: C_MODELS,
    type: 'number',
    placeholder: '12',
    config: { pluginId: ORCHESTRATOR, configKey: 'max_tool_iterations' },
  },
  {
    key: 'ORCHESTRATOR_MODEL_ROUTING',
    label: 'Per-Turn Model-Routing (Haiku-Triage)',
    help: 'Wenn an, klassifiziert ein günstiger Haiku-Call jeden Turn: einfach → Simple-Modell, komplex → Complex-Modell.',
    category: C_MODELS,
    type: 'boolean',
    config: { pluginId: ORCHESTRATOR, configKey: 'orchestrator_model_routing' },
  },
  {
    key: 'MODEL_ROUTING_CLASSIFIER_MODEL',
    label: 'Routing: Klassifizierer-Modell',
    help: 'Haiku-Modell für die Triage. Leer = Default (haiku-4-5).',
    category: C_MODELS,
    type: 'string',
    placeholder: 'claude-haiku-4-5',
    config: { pluginId: ORCHESTRATOR, configKey: 'model_routing_classifier_model' },
  },
  {
    key: 'MODEL_ROUTING_SIMPLE_MODEL',
    label: 'Routing: Modell für einfache Turns',
    help: 'Leer = Default (sonnet-4-6).',
    category: C_MODELS,
    type: 'string',
    placeholder: 'claude-sonnet-4-6',
    config: { pluginId: ORCHESTRATOR, configKey: 'model_routing_simple_model' },
  },
  {
    key: 'MODEL_ROUTING_COMPLEX_MODEL',
    label: 'Routing: Modell für komplexe Turns',
    help: 'Leer = Orchestrator-Modell.',
    category: C_MODELS,
    type: 'string',
    placeholder: 'claude-opus-4-8',
    config: { pluginId: ORCHESTRATOR, configKey: 'model_routing_complex_model' },
  },
  {
    key: 'TOPIC_CLASSIFIER_MODEL',
    label: 'Topic-/Fact-Klassifizierer-Modell',
    help: 'Haiku-Tier-Modell für Topic-Clustering und Fakt-Extraktion.',
    category: C_MODELS,
    type: 'string',
    placeholder: 'claude-haiku-4-5-20251001',
    config: { pluginId: ORCHESTRATOR_EXTRAS, configKey: 'topic_classifier_model' },
  },

  // ── Verifier (@omadia/verifier) ─────────────────────────────────────────
  {
    key: 'VERIFIER_ENABLED',
    label: 'Verifier aktiv',
    help: 'Prüft jede Orchestrator-Antwort gegen Quellen.',
    category: C_VERIFIER,
    type: 'boolean',
    config: { pluginId: VERIFIER, configKey: 'verifier_enabled' },
  },
  {
    key: 'VERIFIER_MODE',
    label: 'Verifier-Modus',
    category: C_VERIFIER,
    type: 'enum',
    options: [
      { value: 'shadow', label: 'shadow (nur protokollieren)' },
      { value: 'enforce', label: 'enforce (blockieren)' },
    ],
    config: { pluginId: VERIFIER, configKey: 'verifier_mode' },
  },
  {
    key: 'VERIFIER_MODEL',
    label: 'Verifier-Modell',
    category: C_VERIFIER,
    type: 'string',
    placeholder: 'claude-haiku-4-5-20251001',
    config: { pluginId: VERIFIER, configKey: 'verifier_model' },
  },
  {
    key: 'VERIFIER_MAX_CLAIMS',
    label: 'Verifier max. Claims',
    category: C_VERIFIER,
    type: 'number',
    placeholder: '20',
    config: { pluginId: VERIFIER, configKey: 'verifier_max_claims' },
  },
  {
    key: 'VERIFIER_MAX_RETRIES',
    label: 'Verifier max. Retries',
    category: C_VERIFIER,
    type: 'number',
    placeholder: '1',
    config: { pluginId: VERIFIER, configKey: 'verifier_max_retries' },
  },

  // ── Wissen & Embeddings ─────────────────────────────────────────────────
  {
    key: 'OLLAMA_BASE_URL',
    label: 'Ollama Base-URL',
    category: C_KNOWLEDGE,
    type: 'url',
    placeholder: 'http://ollama:11434',
    config: { pluginId: EMBEDDINGS, configKey: 'ollama_base_url' },
  },
  {
    key: 'OLLAMA_EMBEDDING_MODEL',
    label: 'Embedding-Modell',
    category: C_KNOWLEDGE,
    type: 'string',
    placeholder: 'nomic-embed-text',
    config: { pluginId: EMBEDDINGS, configKey: 'ollama_model' },
  },
  {
    key: 'GRAPH_TENANT_ID',
    label: 'Knowledge-Graph Tenant-ID',
    category: C_KNOWLEDGE,
    type: 'string',
    placeholder: 'default',
    config: { pluginId: KNOWLEDGE_GRAPH, configKey: 'graph_tenant_id' },
  },
  {
    key: 'GRAPH_EMBEDDING_BACKFILL_ENABLED',
    label: 'Embedding-Backfill aktiv',
    category: C_KNOWLEDGE,
    type: 'boolean',
    config: {
      pluginId: KNOWLEDGE_GRAPH,
      configKey: 'graph_embedding_backfill_enabled',
    },
  },

  // ── Diagramme & Speicher (@omadia/diagrams) ─────────────────────────────
  {
    key: 'KROKI_BASE_URL',
    label: 'Kroki Base-URL',
    category: C_DIAGRAMS,
    type: 'url',
    placeholder: 'http://kroki:8000',
    config: { pluginId: DIAGRAMS, configKey: 'kroki_base_url' },
  },
  {
    key: 'DIAGRAM_PUBLIC_BASE_URL',
    label: 'Öffentliche Diagramm-Base-URL',
    category: C_DIAGRAMS,
    type: 'url',
    config: { pluginId: DIAGRAMS, configKey: 'public_base_url' },
  },
  {
    key: 'AWS_ENDPOINT_URL_S3',
    label: 'S3/Tigris Endpoint',
    category: C_DIAGRAMS,
    type: 'url',
    config: { pluginId: DIAGRAMS, configKey: 'tigris_endpoint' },
  },
  {
    key: 'BUCKET_NAME',
    label: 'S3/Tigris Bucket',
    category: C_DIAGRAMS,
    type: 'string',
    config: { pluginId: DIAGRAMS, configKey: 'tigris_bucket' },
  },
  {
    key: 'AWS_ACCESS_KEY_ID',
    label: 'S3 Access-Key-ID',
    category: C_DIAGRAMS,
    type: 'secret',
    secret: { vaultKey: 'aws_access_key_id', scopes: [DIAGRAMS] },
  },
  {
    key: 'AWS_SECRET_ACCESS_KEY',
    label: 'S3 Secret-Access-Key',
    category: C_DIAGRAMS,
    type: 'secret',
    secret: { vaultKey: 'aws_secret_access_key', scopes: [DIAGRAMS] },
  },

  // ── Integrationen (private byte5-Plugins — werden als "nicht installiert"
  //    angezeigt, wenn das jeweilige Plugin in diesem Deployment fehlt) ─────
  {
    key: 'MICROSOFT_APP_ID',
    label: 'Microsoft App-ID',
    category: C_INTEGRATIONS,
    type: 'string',
    config: { pluginId: MICROSOFT365, configKey: 'microsoft_app_id' },
  },
  {
    key: 'MICROSOFT_APP_TENANT_ID',
    label: 'Microsoft Tenant-ID',
    category: C_INTEGRATIONS,
    type: 'string',
    config: { pluginId: MICROSOFT365, configKey: 'microsoft_tenant_id' },
  },
  {
    key: 'MICROSOFT_APP_PASSWORD',
    label: 'Microsoft App-Passwort',
    category: C_INTEGRATIONS,
    type: 'secret',
    secret: { vaultKey: 'microsoft_app_password', scopes: [MICROSOFT365] },
  },
  {
    key: 'TEAMS_SSO_CONNECTION_NAME',
    label: 'Teams SSO Connection-Name',
    category: C_INTEGRATIONS,
    type: 'string',
    config: { pluginId: TEAMS, configKey: 'teams_sso_connection_name' },
  },
  {
    key: 'TELEGRAM_PUBLIC_BASE_URL',
    label: 'Telegram Public-Base-URL',
    category: C_INTEGRATIONS,
    type: 'url',
    config: { pluginId: TELEGRAM, configKey: 'telegram_public_base_url' },
  },
  {
    key: 'TELEGRAM_BOT_TOKEN',
    label: 'Telegram Bot-Token',
    category: C_INTEGRATIONS,
    type: 'secret',
    secret: { vaultKey: 'telegram_bot_token', scopes: [TELEGRAM] },
  },
  {
    key: 'TELEGRAM_WEBHOOK_SECRET',
    label: 'Telegram Webhook-Secret',
    category: C_INTEGRATIONS,
    type: 'secret',
    secret: { vaultKey: 'telegram_webhook_secret', scopes: [TELEGRAM] },
  },
];

/** Lookup by `.env` key. */
export function findSetting(key: string): SettingDef | undefined {
  return SETTINGS_CATALOG.find((s) => s.key === key);
}

/** Distinct plugin ids a setting touches (config plugin + all secret scopes). */
export function settingPluginIds(def: SettingDef): string[] {
  if (def.config) return [def.config.pluginId];
  if (def.secret) return [...def.secret.scopes];
  return [];
}

/** Category order for stable rendering in the admin overview. */
export const SETTINGS_CATEGORY_ORDER: readonly string[] = [
  C_MODELS,
  C_VERIFIER,
  C_KNOWLEDGE,
  C_DIAGRAMS,
  C_INTEGRATIONS,
];
