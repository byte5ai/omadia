// ===========================================================================
// Admin API v1 — types used by middleware routes.
// ---------------------------------------------------------------------------
// SOURCE OF TRUTH: docs/harness-platform/api/admin-api.v1.ts
// This file is a local copy scoped to what the middleware currently implements.
// Keep in sync. When the admin-ui starts consuming the same types, we promote
// the canonical file to a shared package.
// ===========================================================================

// Epic #470 C7 / G4 — `permissions.sql` is part of the plugin CONTRACT, so its
// shape is defined once on the plugin-api surface and re-exported here rather
// than restated. A second declaration would drift from the one plugin authors
// actually compile against.
import type { SqlPermission } from '@omadia/plugin-api';

export type { SqlPermission };

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
  | 'host_list'
  /**
   * #603 (OM-17): upload a JSON credential file instead of transcribing values
   * out of it. The field itself stores NOTHING — the server parses the upload
   * and explodes it into the keys named in `extracts`, which remain ordinary
   * `secret`/`string` fields for every other code path.
   *
   * Exists because hand-transcribing a service-account key into an email field
   * and a masked field stacked beneath it is the visual pattern of a login, and
   * a tester duly typed their real password into it.
   */
  | 'json_file';

export interface PluginSetupField {
  key: string;
  /**
   * #602 (OM-17) — the field's label, as a `{ <locale>: text }` map. Authored
   * either localized (`{ en: "…", de: "…" }`) or as a bare string the loader
   * reads as English. Resolve with `pickLocalized` at the active locale; falls
   * back to the field `key` when the map is empty. Localized because a manifest
   * that shows an English label above German setup instructions is exactly the
   * two-languages-on-one-page defect OM-17 was raised for.
   */
  label: LocalizedMarkdown;
  type: SetupFieldType;
  /** #602 (OM-17) — Manifest-defined help text as a `{ <locale>: text }` map
   *  (bare string tolerated, read as English). Surfaced on the install wizard
   *  and the post-install credentials editor; render with `pickLocalized`. */
  help?: LocalizedMarkdown;
  /** Manifest-defined input placeholder. Optional UI hint surfaced by the
   *  install wizard and post-install editor; loader passes it through
   *  unchanged. */
  placeholder?: string;
  /**
   * #603 — `json_file` only. MIME type for the file picker's `accept`
   * attribute. Advisory: a picker hint, never a validation. The server decides
   * what the upload is, and `expect` is what actually rejects the wrong file.
   */
  accept?: string;
  /**
   * #603 — `json_file` only. Target setup-field key → `$.dotted.path` into the
   * uploaded document. The extracted values are stored under those keys; the
   * `json_file` field itself stores nothing. See `setupJsonFile.ts` for the
   * supported path subset and why it is not full JSONPath.
   */
  extracts?: Record<string, string>;
  /**
   * #603 — `json_file` only. Shallow equality assertions the uploaded document
   * must satisfy (e.g. `{ type: 'service_account' }`), checked BEFORE any value
   * is extracted so the wrong file is rejected rather than half-consumed.
   */
  expect?: Record<string, unknown>;
  /** Manifest default. Forwarded so the post-install editor can pre-select
   *  the default option in an `enum` dropdown when no value is stored yet.
   *  A `string[]` for `type === 'host_list'`, a `string` otherwise. */
  default?: string | string[];
  /** Allowed values for `type === 'enum'`. Mirrors the install-wizard
   *  schema so the post-install editor can render a `<select>` instead of
   *  a free-text input. */
  enum?: Array<{ value: string; label: string }>;
  /** Spec 005 — for `type === 'oauth'` fields: the `oauth_providers`
   *  descriptor id this field connects through. The kernel broker resolves
   *  the descriptor (+ this field's `scopes`) at flow time. */
  provider?: string;
  /** Spec 005 — OAuth scopes requested for a `type === 'oauth'` field. */
  scopes?: string[];
  /** Dynamic post-install options: the toolkit-tool id (on the SAME plugin)
   *  that returns selectable `SetupOption[]` for this field. The field `type`
   *  stays a normal union member (typically `string`); the post-install editor
   *  fetches options live and stores the picks. Additive + optional — fields
   *  without it behave exactly as before. */
  options_provider?: string;
  /** When true, this field holds MULTIPLE selected values (stored as a
   *  JSON-encoded `string[]`). Only meaningful alongside `options_provider`. */
  multi?: boolean;
  /**
   * OM-16 — whether the operator MUST supply a value for this field before the
   * plugin can serve a request. Required-by-default: a manifest field that
   * omits `required` is required. Parsed with exactly the same rule the
   * install-job schema uses (`installService.ts` → `f['required'] !== false`),
   * so the store view and the install wizard can never disagree.
   *
   * Consumed by `computeReadiness` (plugins/readiness.ts) to decide whether an
   * installed plugin is actually configured, or merely present.
   */
  required?: boolean;
  /**
   * Optional validation regex (source form, no delimiters). Mirrors
   * `InstallSetupField.pattern` so the post-install credentials editor can
   * apply the same constraint the install wizard does.
   */
  pattern?: string;
  /**
   * OM-17 — operator-facing explanation of what `pattern` expects, e.g.
   * "erwartet …@….iam.gserviceaccount.com" or "erwartet einen PEM-Block, der
   * mit -----BEGIN PRIVATE KEY----- beginnt". Same `{ locale: text }` shape as
   * `setup_guide`; the renderer picks the active locale (`pickLocalized`).
   *
   * Exists because a bare "entspricht nicht dem Muster" tells an operator who
   * pasted the wrong KIND of credential nothing about what the right kind is —
   * which is exactly how a tester ended up typing a Google account password
   * into a service-account private-key field.
   */
  pattern_hint?: LocalizedMarkdown;
  /**
   * OM-17 — the manifest declared a `pattern`, but the server REFUSED it (it
   * did not compile, or the catastrophic-backtracking allowlist rejected it),
   * so this field is NOT format-checked. `pattern` is absent in that case.
   *
   * Fail-open is the right call for the write — refusing every value because a
   * plugin author wrote an over-clever regex would brick the plugin — but it
   * must not be SILENT. Without this flag the operator sees a field that looks
   * validated and is not, which is precisely the defect OM-17 exists to fix.
   */
  pattern_unavailable?: boolean;
}

/** A single selectable choice returned by a field's `options_provider` tool. */
export interface SetupOption {
  value: string;
  label: string;
  group?: string;
}

/**
 * Spec 005 — how a declarative OAuth-provider descriptor sends its client
 * credentials + grant params to the token endpoint. `body_form`:
 * x-www-form-urlencoded with the creds in the body (Microsoft). `body_json`:
 * a JSON body (Atlassian). `basic`: HTTP Basic auth header for the client
 * creds, grant params urlencoded in the body.
 */
export type OAuthTokenAuthStyle = 'body_form' | 'body_json' | 'basic';

/**
 * Spec 005 — declarative OAuth-provider descriptor. A plugin that acquires
 * standard authorization-code credentials declares one per IdP in a top-level
 * `oauth_providers:` manifest block; a `type:oauth` setup field references it
 * by `id` through the field's `provider`. The kernel's generic OAuth engine
 * runs the authorize/exchange/refresh dance from this data alone — NO plugin
 * code executes during the flow, so refresh tokens never reach the plugin (the
 * descriptor is inert). Additive + parsed leniently; older cores ignore it.
 */
export interface OAuthProviderDescriptor {
  /** Stable id a `type:oauth` field references via its `provider`. */
  id: string;
  /** Authorization endpoint. May contain `{field}` placeholders interpolated
   *  from the plugin's stored config (e.g. Microsoft's `{tenant_id}` in the
   *  path). Atlassian's is static. */
  authorize_url: string;
  /** Token endpoint. Same `{field}` interpolation as `authorize_url`. */
  token_url: string;
  /** How client credentials + grant params reach the token endpoint. */
  token_auth_style: OAuthTokenAuthStyle;
  /** Emit a PKCE verifier/challenge (S256) and thread it through the flow.
   *  Loader defaults to `true`. */
  pkce: boolean;
  /** Verbatim extra query params on the authorize URL (Atlassian: `audience`,
   *  `prompt`). Optional. */
  extra_authorize_params?: Record<string, string>;
  /** Setup-field key holding the OAuth client id (resolved from the plugin's
   *  stored config/vault at flow time). */
  client_id_field: string;
  /** Setup-field key (secret type) holding the OAuth client secret. */
  client_secret_field: string;
}

export interface PluginPermissionsSummary {
  /** Epic #470 C7 / G4 — the plugin asks to hold a Postgres pool and own its
   *  own tables (`permissions.sql`). Present only when the manifest declares a
   *  well-formed block whose `ledger` this plugin is allowed to own; the
   *  loader drops a malformed one with a warning. Declaration is half the
   *  gate — `platform/pluginSqlGrants.ts` additionally requires an operator
   *  grant row before `graphPool` resolves or `ctx.sql` is built. */
  sql?: SqlPermission;
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
  /** Spec 005 (US4 Conductor Surface): plugin declares `permissions.events.emit: true` and may
   *  emit declared domain events via `ctx.events`. Loader defaults to `false`. */
  events_emit?: boolean;
  /** Epic #459 W5 (issue #458): plugin declares `permissions.mcp` (true or a
   *  block) and receives `ctx.mcp`, scoped to operator-granted servers.
   *  Loader defaults to `false`. */
  mcp?: boolean;
  /** Optional author hint (`permissions.mcp.servers_hint`): human-readable
   *  descriptions of the servers the plugin expects, shown in the grant UI.
   *  Granting is ALWAYS an explicit operator action. */
  mcp_servers_hint?: string[];
  /** Spec 005: true when the manifest declares >=1 `oauth_providers`
   *  descriptor — the plugin acquires standard authorization-code credentials
   *  through the kernel OAuth broker (tokens stored + refreshed kernel-side;
   *  refresh tokens never reach plugin code). Surfaced as a store-detail chip.
   *  Loader defaults to `false`. */
  acquires_oauth?: boolean;
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

/**
 * Spec 004 — operator-facing plugin health, pushed by the plugin via
 * `ctx.status` (mirror of `@omadia/plugin-api`'s `PluginActionStatus`, kept
 * inline so this type contract stays dependency-free).
 */
export type PluginActionState = 'ok' | 'needs_action' | 'error';

export interface PluginActionStatus {
  state: PluginActionState;
  title?: string;
  detail?: string;
}

/**
 * OM-16 — kernel-derived plugin readiness.
 *
 * `install_state` and `InstalledAgent.status` are two independent state axes
 * and neither answers the operator's actual question ("will this plugin serve
 * a request?"). `install_state` stops at "is it in the registry", and
 * `InstalledAgent.status` never leaves the server. Readiness is the derived
 * third view: it inspects the plugin's *declared required setup fields*
 * against the vault + the stored config and reports whether the plugin is
 * genuinely usable.
 *
 * Unlike `PluginActionStatus` (push-only, plugins that call `ctx.status`),
 * readiness is computed by the kernel and therefore also covers the majority
 * of plugins that never report status at all.
 */
export type PluginReadinessState =
  | 'not_installed'
  | 'config_required'
  | 'ready'
  | 'errored';

export interface PluginReadiness {
  state: PluginReadinessState;
  /** Keys of required setup fields with no stored value. Empty unless
   *  `state === 'config_required'`. */
  missing_fields: string[];
  /** ISO8601 of the moment readiness was last observed as `ready`, i.e. the
   *  plugin's last successful activation (falls back to `installed_at`).
   *  `null` for every non-ready state. */
  verified_at: string | null;
  /** Tail of the last activation error. Only for `state === 'errored'`. */
  error_detail?: string;
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
  /** All declared setup fields (secret AND non-secret config) from the
   *  manifest's `setup.fields`. Named `setup_fields` because the list is not
   *  secrets-only — it carries `string`/`url`/`enum`/`boolean`/`integer`
   *  config alongside `secret`/`oauth` credentials. Consumers split the two
   *  by each field's `type`. */
  setup_fields: PluginSetupField[];
  /** Spec 005 — declarative OAuth-provider descriptors from the manifest's
   *  top-level `oauth_providers:` block. The kernel's generic OAuth broker
   *  resolves a `type:oauth` field's `provider` against these at flow time.
   *  Present only when the manifest declares at least one. */
  oauth_providers?: OAuthProviderDescriptor[];
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
   * Spec 004 — operator-facing action status the (active) plugin pushed via
   * `ctx.status`. Present only while it reports `needs_action` / `error`;
   * absent for `ok` or an inactive plugin. The web-ui renders it as a badge on
   * the plugin card + a banner on the detail page, both clearing when the
   * plugin reports `ok`.
   */
  action_status?: PluginActionStatus;
  /**
   * OM-16 — kernel-derived readiness. Orthogonal to `install_state`: a plugin
   * can be `install_state: 'installed'` while every required credential is
   * empty, in which case it cannot serve a single request. `install_state`
   * answers "is it present?", `readiness` answers "can it actually work?".
   *
   * Optional on purpose — an older middleware omits it and an older web-ui
   * ignores it, so both directions of the version skew keep working. Never
   * widen `PluginInstallState` for this: 20+ call sites branch on
   * `=== 'installed'`.
   */
  readiness?: PluginReadiness;
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
  /**
   * OM-15 (#602) — installation-effort profile surfaced on the store CARD,
   * BEFORE install. Declared in the manifest's `listing.setup_profile`. Exists
   * because a tester installed a plugin, then discovered it needed a Google
   * Cloud service account, seven enabled APIs and Workspace super-admin rights —
   * information they should have had while still deciding whether to install.
   * Optional and additive; absent for plugins that declare no profile.
   */
  setup_profile?: SetupProfile;
}

/**
 * OM-15 (#602) — who has to perform the setup. Renders as a localized label on
 * the card (`it_admin` → "Einrichtung durch IT-Administrator"). Unknown values
 * are dropped by the loader rather than shown raw.
 */
export type SetupAudience = 'it_admin' | 'operator' | 'end_user';

/**
 * OM-15 (#602) — structured installation-effort metadata for the store card.
 * The platform COMPOSES the display line from these fields via next-intl (so the
 * card stays localized and the plugin author does not hand-write German), e.g.
 * "Einrichtung durch IT-Administrator · ca. 15 Min · Google-Workspace-Super-Admin
 * erforderlich". Every field is optional; the card renders only the parts present.
 */
export interface SetupProfile {
  /** Who performs the setup. Omitted when the manifest value is unrecognised. */
  audience?: SetupAudience;
  /** Rough hands-on setup time in minutes. Positive integer; omitted otherwise. */
  estimated_minutes?: number;
  /** A single extra prerequisite worth calling out up front (e.g. required
   *  admin role), as a `{ <locale>: text }` map. Render with `pickLocalized`. */
  requirement?: LocalizedMarkdown;
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

/** Advisory code-scan verdict for an ingested plugin package (issue #453).
 *  Absent when the plugin was never scanned (built-ins, no scanner). */
export interface PluginVerdict {
  severity:
    | 'no_signals'
    | 'flagged'
    | 'high_risk'
    | 'scan_failed'
    | 'pending'
    | 'too_large_to_scan';
  findings: readonly {
    readonly code: string;
    readonly severity: string;
    readonly message: string;
    readonly file: string | null;
  }[];
  scanner_version: string;
  rationale: string | null;
  computed_at: ISO8601;
  ack: { by: string; at: ISO8601 } | null;
}

export interface StoreGetResponse {
  plugin: Plugin;
  manifest: unknown;
  install_available: boolean;
  blocking_reasons?: string[];
  /** Advisory-only — never blocks install (issue #453). */
  verdict?: PluginVerdict;
  /** OM-06 / #671 — set when install is blocked because an ACTIVE plugin
   *  already provides one of this plugin's capabilities. The install would be
   *  refused with 409 `install.capability_already_provided`, so the store must
   *  not advertise it.
   *
   *  Structured rather than folded into `blocking_reasons`, which is a list of
   *  server-authored English strings the client can only print: the operator's
   *  next step here is to CONFIGURE the provider that already exists, and a
   *  client cannot build that link by parsing prose. */
  blocked_by_active_provider?: {
    /** The capability slot, e.g. `llmProvider@1`. */
    capability: string;
    /** Plugin id already providing it. */
    owner_id: string;
  };
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
  /** #602 (OM-17) — localized label map; see `PluginSetupField.label`. Both
   *  projections normalise it identically so the install wizard and the store
   *  view render the same text. */
  label: LocalizedMarkdown;
  /** #602 (OM-17) — localized help map; see `PluginSetupField.help`. */
  help?: LocalizedMarkdown;
  required: boolean;
  default?: unknown;
  enum?: Array<{ value: string; label: string }>;
  provider?: string;
  scopes?: string[];
  pattern?: string;
  /** OM-17 — localized explanation of what `pattern` expects. See
   *  `PluginSetupField.pattern_hint`; parsed by the same manifest read so the
   *  install wizard and the post-install editor say the same thing. */
  pattern_hint?: LocalizedMarkdown;
  /** OM-17 — the manifest declared a `pattern` the server refused (uncompilable
   *  or rejected by the ReDoS allowlist), so this field goes UNCHECKED. See
   *  `PluginSetupField.pattern_unavailable`. */
  pattern_unavailable?: boolean;
  /** OM-17 — manifest-declared input placeholder, forwarded to the install
   *  wizard. It used to be parsed for the catalog view only, while the wizard
   *  hardcoded `••••••••` over every secret field. */
  placeholder?: string;
  /** Render as multi-row textarea (string/secret only) — for values that
   *  contain newlines, e.g. PEM private keys. Older UIs ignore the flag
   *  and fall back to a single-line input. */
  multiline?: boolean;
  /** Omit this field from the initial install flyout to keep first-time setup
   *  minimal. The field stays declared (so a runtime flow may write it via
   *  `ctx.config.set`) and editable later via the store-detail setup editor —
   *  it just isn't shown at install time. For flow-populated credentials.
   *  Older UIs ignore the flag and render the field as usual. */
  install_hidden?: boolean;
  /**
   * #603 — `json_file` only. Mirrors {@link PluginSetupField.accept}: the file
   * picker's `accept` hint. Advisory — the server, not the picker, decides what
   * an upload actually is.
   */
  accept?: string;
  /**
   * #603 — `json_file` only. Mirrors {@link PluginSetupField.extracts}.
   *
   * Carried on the INSTALL projection too, not just the catalog one, because
   * `POST …/secrets/from-json` resolves the extraction map through
   * `extractSetupSchema` — which returns THIS type. A `json_file` field that
   * reaches the route without it carries no upload contract and is refused,
   * so an omission here is a silently dead upload button.
   */
  extracts?: Record<string, string>;
  /**
   * #603 — `json_file` only. Mirrors {@link PluginSetupField.expect}: shallow
   * assertions the uploaded document must satisfy before anything is extracted.
   */
  expect?: Record<string, unknown>;
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
