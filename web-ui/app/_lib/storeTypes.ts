// -----------------------------------------------------------------------------
// Plugin-Store types. Mirrors docs/harness-platform/api/admin-api.v1.ts
// (namespace Store) and middleware/src/api/admin-v1.ts.
// Keep in sync manually until we promote admin-api.v1.ts to a shared package.
// -----------------------------------------------------------------------------

export type SetupFieldType =
  | 'string'
  | 'url'
  | 'secret'
  | 'oauth'
  | 'enum'
  | 'boolean'
  | 'integer'
  /** #91 — operator-curated list of bare hostnames. */
  | 'host_list';

/** #91 — operator-selected egress mode for an audit/scanner plugin. */
export type AuditMode = 'single-host' | 'allowlist' | 'public-web';

export interface PluginSetupField {
  key: string;
  label: string;
  type: SetupFieldType;
  /** Optional help text from the manifest. Surfaced inline in the
   *  post-install credentials editor. */
  help?: string;
  /** Manifest default. The post-install editor pre-selects this value in
   *  an `enum` dropdown when nothing is stored yet. */
  default?: string;
  /** Allowed values for `type === 'enum'`. When present, the
   *  post-install editor renders a `<select>` instead of a text input. */
  enum?: Array<{ value: string; label: string }>;
}

export interface PluginPermissionsSummary {
  memory_reads: string[];
  memory_writes: string[];
  graph_reads: string[];
  graph_writes: string[];
  network_outbound: string[];
  /** #91 — true when the plugin is an audit/scanner whose `ctx.http` may
   *  reach arbitrary public hosts (gated by the operator-selected
   *  `audit_mode`). Optional: absent on pre-#91 store payloads. */
  network_web_scanner?: boolean;
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
  | 'tool'
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

export interface PluginJobSpec {
  name: string;
  schedule: { cron: string } | { intervalMs: number };
  timeout_ms?: number;
  overlap?: 'skip' | 'queue';
}

export interface Plugin {
  id: string;
  kind: PluginKind;
  name: string;
  version: string;
  latest_version: string;
  description: string;
  authors: Array<{ name: string; email?: string; url?: string }>;
  license: string;
  icon_url: string | null;
  categories: string[];
  compat_core: string;
  signed: boolean;
  signed_by: string | null;
  /** All declared setup fields (secret AND non-secret config) from the
   *  manifest's `setup.fields`. Not secrets-only — split by each field's
   *  `type` (secret/oauth → vault, everything else → instance config). */
  setup_fields: PluginSetupField[];
  permissions_summary: PluginPermissionsSummary;
  integrations_summary: string[];
  install_state: PluginInstallState;
  incompatibility_reasons?: string[];
  depends_on: string[];
  /** Manifest-declared background jobs. Always present (defaults to []). */
  jobs?: PluginJobSpec[];
  /** Capabilities this plugin provides (e.g. `["memoryStore@1"]`). Always
   *  present (defaults to []). Mirrors middleware admin-v1. */
  provides?: string[];
  /** Capabilities this plugin requires (e.g. `["knowledgeGraph@^1"]`).
   *  The middleware install-time gate rejects the install with
   *  `install.missing_capability` (409) if any entry has no active
   *  provider; the response details carry the chain to install. */
  requires?: string[];
  channel?: ChannelManifestBlock;
  /**
   * Optional plugin-bundled operator-admin UI path (S+7.7). When set, this
   * page embeds an iframe with `src=/bot-api<path>` once the plugin is
   * 'active'. The plugin owns the UI assets and serves them via the
   * channel-SDK's `core.registerRouter`.
   */
  admin_ui_path?: string;
  /** Present only for entries sourced from a remote registry that are not yet
   *  ingested locally. Drives the remote-install flow (fetch-then-ingest
   *  before the normal install job). Mirrors middleware admin-v1. */
  source?: {
    registry: string;
    download_url: string;
    sha256: string;
  };
  /** C6 — newer version a registry advertises when `install_state ===
   *  'update-available'`. `version` still reflects what is installed. */
  available_version?: string;
  /** Localized markdown installation guide for the plugin's third-party system,
   *  from the manifest's `setup.guide` as a `{ <locale>: markdown }` map. The
   *  UI picks the active locale (with fallback) and renders it on the detail
   *  page and in the install drawer ("how to create a Discord bot", "how to get
   *  M365 credentials"). Mirrors middleware admin-v1. */
  setup_guide?: LocalizedMarkdown;
}

/** UI text available in several languages, keyed by locale (`en`, `de`, …).
 *  Mirrors `LocalizedMarkdown` in middleware admin-v1. */
export type LocalizedMarkdown = Record<string, string>;

export interface StoreListResponse {
  items: Plugin[];
  next_cursor: string | null;
  total?: number;
}

export interface StoreGetResponse {
  plugin: Plugin;
  manifest: unknown;
  install_available: boolean;
  blocking_reasons?: string[];
}

// ---------------------------------------------------------------------------
// Install namespace (mirror from admin-v1.ts)
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
  multiline?: boolean;
}

export interface InstallSetupSchema {
  fields: InstallSetupField[];
}

export interface InstallJobError {
  code: string;
  message: string;
  details?: unknown;
}

export interface InstallJob {
  id: string;
  plugin_id: string;
  plugin_version: string;
  state: InstallJobState;
  current_step: string;
  error: InstallJobError | null;
  setup_schema: InstallSetupSchema | null;
  created_at: string;
  updated_at: string;
}

export interface InstallCreateResponse {
  job: InstallJob;
}

export interface InstallConfigureResponse {
  job: InstallJob;
  agent_id: string;
}

export interface InstallValidationError {
  key: string;
  code: string;
  message: string;
}

// ---------------------------------------------------------------------------
// S+8.5 capability-hardening — install-chain resolution
// ---------------------------------------------------------------------------
// Mirrors middleware/src/plugins/capabilityResolver.ts:
//   `InstallChainResolution`, `UnresolvedCapabilityEntry`,
//   `CapabilityProviderRef`.
// Returned as `details` on a 409 `install.missing_capability` response —
// the wizard renders this verbatim, no client-side recursion.

export interface CapabilityProviderRef {
  id: string;
  name: string;
  kind: PluginKind;
  version: string;
  install_state: PluginInstallState;
  /** True iff already in `installedRegistry` (any status). */
  already_installed: boolean;
  /** True iff status === 'active' (registered + activated). */
  active: boolean;
}

export interface UnresolvedCapabilityEntry {
  /** Raw manifest string, e.g. `"knowledgeGraph@^1"`. */
  capability: string;
  /** Catalog plugins matching the cap. Empty array means the catalog
   *  has no candidate at all — the wizard surfaces this as a hard
   *  block (operator must upload a provider package first). */
  providers: CapabilityProviderRef[];
}

export interface InstallChainResolution {
  /** Capability strings missing in the install-chain, topo-sorted —
   *  deepest pre-requisites first. Wizard installs in this order. */
  unresolved_requires: string[];
  /** Per-capability list of catalog providers, same order as
   *  `unresolved_requires`. */
  available_providers: UnresolvedCapabilityEntry[];
}

// ---------------------------------------------------------------------------
// Uploaded packages (Zip-Upload-Flow)
// ---------------------------------------------------------------------------

export interface UploadedPackage {
  id: string;
  version: string;
  path: string;
  uploaded_at: string;
  uploaded_by: string;
  sha256: string;
  peers_missing: string[];
  zip_bytes: number;
  extracted_bytes: number;
  file_count: number;
}

export interface UploadPackageResponse {
  package: UploadedPackage;
}

export interface ListUploadedPackagesResponse {
  items: UploadedPackage[];
}

export interface UploadErrorBody {
  code: string;
  message: string;
  details?: unknown;
}
