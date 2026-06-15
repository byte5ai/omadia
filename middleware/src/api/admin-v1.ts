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
  | 'integer'
  /** #91: operator-curated list of bare hostnames. Values are unioned into
   *  the plugin's effective `ctx.http` allowlist at runtime (Option B). */
  | 'host_list';

export interface PluginSetupField {
  key: string;
  label: string;
  type: SetupFieldType;
  /** Manifest-defined help text. Surfaced on the post-install credentials
   *  editor so the operator sees the same hint as in the install wizard. */
  help?: string;
  /** Manifest-defined input placeholder. Optional UI hint surfaced by the
   *  install wizard and post-install editor; loader passes it through
   *  unchanged. */
  placeholder?: string;
  /** Manifest default. Forwarded so the post-install editor can pre-select
   *  the default option in an `enum` dropdown when no value is stored yet.
   *  A `string[]` for `type === 'host_list'`, a `string` otherwise. */
  default?: string | string[];
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
  /** #91: when true the plugin is an audit/scanner — its `ctx.http` may
   *  contact arbitrary public hosts at runtime (target URLs are supplied
   *  by the end user and unknown at build time). The runtime egress filter
   *  still hard-blocks private IP ranges and cloud-metadata endpoints, and
   *  the operator must confirm at install time. Optional; the loader
   *  defaults to `false`. */
  network_web_scanner?: boolean;
  /** #91: a web_scanner plugin MAY declare its intended default audit mode
   *  (`single-host` | `allowlist` | `public-web`). The kernel uses it as the
   *  EFFECTIVE mode when the operator has not overridden `audit_mode` in the
   *  installed-registry config — so a scanner ships open-by-intent without an
   *  extra operator step. Ignored for non-web_scanner plugins (forced
   *  `single-host`). Optional; the loader leaves it undefined when absent. */
  network_default_audit_mode?: 'single-host' | 'allowlist' | 'public-web';
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
  /** Spec 004: plugin may write its OWN vault secrets + config at runtime
   *  (`ctx.secrets.set`/`delete`, `ctx.config.set`). Namespace-locked — a
   *  plugin can never reach another's secrets. Surfaced as a store-detail
   *  chip. Loader defaults to `false`. */
  secrets_runtime_write?: boolean;
  /** Spec 004: plugin runs credential-acquisition flows on its own routes —
   *  the `ctx.flows` accessor (public-callback-URL resolution + kernel-held
   *  state signing) is provisioned. Loader defaults to `false`. */
  flows?: boolean;
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
  | 'typing_indicator'
  /** Omadia UI canvas surface — channel renders the live primitive tree and the
   *  `surface_*` event family. Additive; classic channels never declare it. */
  | 'canvas';

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
  /**
   * Omadia UI (additive): the bare service-registry key this channel's turns
   * dispatch to. Absent → the shared 'chatAgent' orchestrator (classic
   * behaviour). The canvas channel sets `canvasChatAgent`. NOTE: a bare key,
   * not `name@N` — the service registry does not strip versions; `@N` lives
   * only in the provider's `provides:`/`requires:` capability list.
   */
  dispatch_service?: string;
  /**
   * US7 per-binding routing (additive): the short `channel_bindings.channel_type`
   * selector this channel's turns route under (`"teams"`, `"telegram"`, …).
   * Absent → the core derives it from the last dotted segment of the plugin id
   * (`de.byte5.channel.teams` → `teams`). Declare it only when the id does not
   * follow the `*.channel.<type>` convention. See `deriveChannelType`.
   */
  channel_type?: string;
  /**
   * Omadia UI (additive): the omadia-canvas-protocol version this channel
   * speaks (e.g. `"1.0"`). Informational at the manifest layer; the actual
   * version is negotiated in the boot handshake.
   */
  canvas_protocol_version?: string;
}

/**
 * A short piece of UI text available in several languages, keyed by locale
 * (`en`, `de`, …). Used for the manifest-declared `setup.guide`. The renderer
 * picks the active locale and falls back to another when it is missing.
 */
export type LocalizedMarkdown = Record<string, string>;

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
  /** All declared setup fields (secret AND non-secret config) from the
   *  manifest's `setup.fields`. Named `setup_fields` because the list is not
   *  secrets-only — it carries `string`/`url`/`enum`/`boolean`/`integer`
   *  config alongside `secret`/`oauth` credentials. Consumers split the two
   *  by each field's `type`. */
  setup_fields: PluginSetupField[];
  permissions_summary: PluginPermissionsSummary;
  integrations_summary: string[];
  install_state: PluginInstallState;
  incompatibility_reasons?: string[];
  /** Present only for entries sourced from a remote registry that are not yet
   *  downloaded/ingested locally. Its presence is what tells the install flow
   *  to fetch-then-ingest (POST /api/v1/install/registry/:id) before the
   *  normal install-job. Structurally mirrors `RegistrySource` in
   *  `api/registry-v1.ts`. */
  source?: {
    registry: string;
    download_url: string;
    sha256: string;
  };
  /** C6 — set when `install_state === 'update-available'`: the newer version a
   *  configured registry advertises vs the installed one. The `version` field
   *  still reflects what is installed. */
  available_version?: string;
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
  /**
   * Builder service-type declarations (OB — service-type auto-discovery).
   * Integration plugins list every `ctx.services.provide(...)` surface they
   * expose, mapped to the TypeScript type a consuming agent imports. When
   * such a plugin activates, the kernel registers each entry into the
   * agent-builder's runtime `serviceTypeRegistry` so a generated agent that
   * declares `external_reads` against this service typechecks + resolves at
   * activate-time — and unregisters on deactivation. Empty/absent for
   * plugins that expose no builder-consumable services. Distinct from
   * `provides` (capability-refs like `graph@1`): these carry the concrete
   * `import type` target codegen needs. */
  service_types?: ServiceTypeDecl[];
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
  /**
   * Multi-orchestrator runtime — may this plugin be activated for more
   * than one Agent in a single process? Defaults to `true` (the loader
   * fills it); a plugin that genuinely cannot sets `multi_instance: false`
   * in its `manifest.yaml` and supplies `multi_instance_justification`.
   */
  multi_instance: boolean;
  /** Required (non-empty) reason when `multi_instance` is `false`. */
  multi_instance_justification?: string;
  /**
   * Plugin data-handling class, declared in `manifest.yaml`. Recorded for
   * a later privacy workstream; not enforced today. Defaults to `default`.
   */
  privacy_class: 'strict' | 'default';
  /**
   * Localized markdown installation guide for the plugin's third-party system,
   * declared in the manifest's `setup.guide` as a `{ <locale>: markdown }` map
   * (e.g. `{ en, de }`). Answers "how do I get this running" questions (create
   * a Discord bot, register an Azure AD app, …). Optional; the UI picks the
   * active-locale string (falling back to another locale) and renders it as
   * markdown on the store detail page and in the install drawer. Display-only —
   * never parsed for behaviour.
   */
  setup_guide?: LocalizedMarkdown;
}

/**
 * A single builder service-type declaration from a plugin's manifest
 * `service_types:` block. Mirrors `ServiceTypeRegistration` in the
 * agent-builder's `serviceTypeRegistry.ts` (kept inline here so `admin-v1.ts`
 * stays import-free, consistent with the rest of this module). The kernel
 * translates each entry into a `registerServiceType(service, { providedBy,
 * typeImport })` call when the providing plugin activates.
 */
export interface ServiceTypeDecl {
  /** Service-registry key the plugin publishes via `ctx.services.provide`,
   *  e.g. `"odoo.client"`. This is what a consuming agent passes to
   *  `ctx.services.get(...)` and lists in `spec.external_reads[].service`. */
  service: string;
  /** The TypeScript type a consumer imports for this service. */
  type: {
    /** npm/workspace package id the type is imported `from`, e.g.
     *  `"@omadia/integration-odoo"`. Codegen also emits this as the
     *  generated agent's `peerDependencies` entry. */
    from: string;
    /** Exported type name, e.g. `"OdooClient"`. */
    name: string;
  };
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
  /** Render as multi-row textarea (string/secret only) — for values that
   *  contain newlines, e.g. PEM private keys. Older UIs ignore the flag
   *  and fall back to a single-line input. */
  multiline?: boolean;
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
