// ===========================================================================
// Admin API v1 — types used by middleware routes.
// ---------------------------------------------------------------------------
// SOURCE OF TRUTH: docs/harness-platform/api/admin-api.v1.ts
// This file is a local copy scoped to what the middleware currently implements.
// Keep in sync. When the admin-ui starts consuming the same types, we promote
// the canonical file to a shared package.
// ===========================================================================

export type ISO8601 = string;
export type EntityURI = string;
export type AgentId = string;

export interface ApiError {
  code: string;
  message: string;
  details?: unknown;
  trace_id?: string;
}

export interface PageRequest {
  cursor?: string;
  limit?: number;
}

export interface Page<T> {
  items: T[];
  next_cursor: string | null;
  total?: number;
}

// ---------------------------------------------------------------------------
// Store namespace — what /api/v1/store/plugins returns
// ---------------------------------------------------------------------------

export type SetupFieldType =
  | 'string'
  | 'url'
  | 'secret'
  | 'oauth'
  | 'enum'
  | 'boolean'
  | 'integer';

export interface PluginSetupField {
  key: string;
  label: string;
  type: SetupFieldType;
  /** Manifest-defined help text. Surfaced on the post-install credentials
   *  editor so the operator sees the same hint as in the install wizard. */
  help?: string;
  /** Manifest default. Forwarded so the post-install editor can pre-select
   *  the default option in an `enum` dropdown when no value is stored yet. */
  default?: string;
  /** Allowed values for `type === 'enum'`. Mirrors the install-wizard
   *  schema so the post-install editor can render a `<select>` instead of
   *  a free-text input. */
  enum?: Array<{ value: string; label: string }>;
}

export interface PluginPermissionsSummary {
  memory_reads: string[];
  memory_writes: string[];
  graph_reads: EntityURI[];
  graph_writes: EntityURI[];
  network_outbound: string[];
  /** OB-29-1: agentId whitelist this plugin may call via `ctx.subAgent.ask`.
   *  Wildcards allowed (`'de.byte5.agent.*'`). Optional to keep legacy
   *  fixtures buildable; the loader always populates with `[]` when the
   *  manifest omits it. Empty array → `ctx.subAgent` is `undefined`. */
  sub_agents_calls?: string[];
  /** OB-29-1: per tool-handler invocation, max number of `ctx.subAgent.ask`
   *  calls. Optional; loader defaults to 5 when the manifest omits it. */
  sub_agents_calls_per_invocation?: number;
  /** OB-29-2: free-form system-namespace strings this plugin may use as
   *  `EntityIngest.system` when writing PluginEntity nodes via
   *  `ctx.knowledgeGraph.ingestEntities`. Reserved: `'odoo'`, `'confluence'`
   *  (host integrations) — entries matching these are stripped at load
   *  time. Empty/missing → `ctx.knowledgeGraph` is `undefined`. */
  graph_entity_systems?: string[];
  /** OB-29-3: model whitelist this plugin may call via `ctx.llm.complete`.
   *  Glob suffix `*` is supported (`'claude-haiku-4-5*'`). Empty/missing
   *  → `ctx.llm` is `undefined`. */
  llm_models_allowed?: string[];
  /** OB-29-3: per createPluginContext lifetime, max number of
   *  `ctx.llm.complete` calls. Loader defaults to 5 when manifest omits it. */
  llm_calls_per_invocation?: number;
  /** OB-29-3: hard-cap on `LlmCompleteRequest.maxTokens`. Plugin-side
   *  larger values are silently clamped, not rejected. Default 4096. */
  llm_max_tokens_per_call?: number;
}

export type PluginInstallState =
  | 'available'
  | 'installed'
  | 'update-available'
  | 'incompatible';

export type PluginKind =
  | 'agent'
  | 'integration'
  | 'channel'
  /** Headless native-tool package. activate() registers via ctx.tools /
   *  ctx.routes and returns a close-only handle (no toolkit). Example:
   *  @omadia/diagrams contributes `render_diagram` + the `/diagrams`
   *  signed-url proxy. */
  | 'tool'
  /** Cross-cutting extension (turn-hooks, background jobs, prompt blocks).
   *  Reserved for Phase 4 (Verifier + KG). No runtime support yet. */
  | 'extension';

export type ChannelTransportKind = 'webhook' | 'websocket' | 'long-poll';

export type ChannelCapability =
  | 'text'
  | 'attachments'
  | 'interactive_cards'
  | 'user_sso'
  | 'file_upload'
  | 'typing_indicator';

export type ChannelAdapter =
  | 'text'
  | 'markdown'
  | 'adaptive_card'
  | 'block_kit'
  | 'interactive_message'
  | 'discord_components'
  | 'telegram_keyboard';

export interface ChannelTransportRoute {
  path: string;
  method: string;
}

export interface ChannelManifestBlock {
  transport: {
    kind: ChannelTransportKind;
    routes: ChannelTransportRoute[];
    verify_signature: boolean;
  };
  capabilities: ChannelCapability[];
  adapters: ChannelAdapter[];
}

export interface Plugin {
  id: AgentId;
  kind: PluginKind;
  name: string;
  version: string;
  latest_version: string;
  description: string;
  authors: Array<{ name: string; email?: string; url?: string }>;
  license: string;
  icon_url: string | null;
  categories: string[];
  /**
   * OB-77 (Palaia Phase 8) — first-class plugin Domain.
   *
   * Lowercase dotted identifier (e.g. `confluence`, `odoo.hr`,
   * `m365.calendar`) declared in the manifest's `identity.domain`. Required
   * at the manifest level; the loader auto-fallbacks to `unknown.<plugin-id>`
   * with a warning when a plugin ships without one. Consumed by the
   * Nudge-Pipeline's multi-domain trigger and the Operator Admin UI for
   * cross-agent grouping.
   */
  domain: string;
  compat_core: string;
  signed: boolean;
  signed_by: string | null;
  required_secrets: PluginSetupField[];
  permissions_summary: PluginPermissionsSummary;
  integrations_summary: string[];
  install_state: PluginInstallState;
  incompatibility_reasons?: string[];
  /** Parent plugin identities this one inherits secrets/config from. */
  depends_on: AgentId[];
  /** Background jobs the plugin contributes via its manifest. Always
   *  present (defaults to empty array). Programmatic registrations made
   *  through `ctx.jobs.register(...)` are NOT reflected here — this field
   *  describes only the manifest-declared jobs. */
  jobs: PluginJobSpec[];
  /** Capabilities this plugin provides. Manifest strings of the form
   *  `"<name>@<major>"` (e.g. `"memory.kv@1"`). Always present (defaults
   *  to empty array). See `parseCapabilityRef` in `@omadia/plugin-api`
   *  for the syntax contract. */
  provides: string[];
  /** Capabilities this plugin requires. Manifest strings of the form
   *  `"<name>@<major>"` or `"<name>@^<major>"`. Always present (defaults
   *  to empty array). The kernel rejects boot if any `requires` has no
   *  matching `provides` across the installed plugin set. */
  requires: string[];
  /** Channel-specific block. Present iff kind === 'channel'. */
  channel?: ChannelManifestBlock;
  /**
   * Optional plugin-bundled operator-admin UI path (S+7.7). When set, the
   * web-ui store-detail page embeds an iframe with src=`/bot-api<path>`
   * for plugins in the 'active' install state. The plugin must mount the
   * UI itself via `core.registerRouter` — kernel does not serve it.
   * Path includes a leading slash, e.g. `/api/telegram/admin/ui/`.
   */
  admin_ui_path?: string;
  /**
   * OB-29-0 marker. When `true`, this plugin is a Builder-Reference
   * (Pattern-Quelle für den BuilderAgent) and MUST NOT appear in the
   * Operator-Plugin-Catalog. The Store-Endpoint filters these out; the
   * BuilderAgent reaches them via `BUILDER_REFERENCE_ESSENTIALS` instead.
   */
  is_reference_only?: boolean;
}

/**
 * Manifest-declared background-job descriptor. Mirror of `JobSpec` from
 * `@omadia/plugin-api` — kept inline here so that `admin-v1.ts`
 * stays import-free (consistent with `depends_on: string[]`, which also
 * intentionally avoids leaking the plugin-api type surface).
 */
export interface PluginJobSpec {
  name: string;
  schedule: PluginJobSchedule;
  timeout_ms?: number;
  overlap?: 'skip' | 'queue';
}

export type PluginJobSchedule =
  | { cron: string }
  | { intervalMs: number };

export type StoreListResponse = Page<Plugin>;

export interface StoreGetResponse {
  plugin: Plugin;
  manifest: unknown;
  install_available: boolean;
  blocking_reasons?: string[];
}

// ---------------------------------------------------------------------------
// Install namespace — /api/v1/install/*
// ---------------------------------------------------------------------------

export type InstallJobState =
  | 'created'
  | 'awaiting_config'
  | 'configuring'
  | 'active'
  | 'failed'
  | 'cancelled';

export interface InstallSetupField {
  key: string;
  type: SetupFieldType;
  label: string;
  help?: string;
  required: boolean;
  default?: unknown;
  enum?: Array<{ value: string; label: string }>;
  provider?: string;
  scopes?: string[];
  pattern?: string;
}

export interface InstallSetupSchema {
  fields: InstallSetupField[];
}

export interface InstallJob {
  id: string;
  plugin_id: AgentId;
  plugin_version: string;
  state: InstallJobState;
  current_step: string;
  error: ApiError | null;
  setup_schema: InstallSetupSchema | null;
  created_at: ISO8601;
  updated_at: ISO8601;
}

export interface InstallCreateResponse {
  job: InstallJob;
}

export interface InstallGetResponse {
  job: InstallJob;
}

export interface InstallConfigureRequest {
  values: Record<string, unknown>;
}

export interface InstallConfigureResponse {
  job: InstallJob;
  agent_id: AgentId;
}
