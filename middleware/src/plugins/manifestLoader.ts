import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

import {
  parseCapabilityRef,
  validatePluginDomain,
} from '@omadia/plugin-api';

import type {
  ChannelAdapter,
  ChannelCapability,
  ChannelManifestBlock,
  ChannelTransportKind,
  ChannelTransportRoute,
  OAuthProviderDescriptor,
  Plugin,
  PluginJobSchedule,
  PluginJobSpec,
  PluginKind,
  PluginPermissionsSummary,
  PluginSetupField,
  ServiceTypeDecl,
} from '../api/admin-v1.js';

/**
 * Loads plugin manifests from a single source:
 *   `<repo>/docs/harness-platform/examples/*.manifest.yaml`
 *
 * Schema-v1 manifests are the only authoritative catalog entries. The old
 * `<repo>/agent-config-*.yaml` files remain on disk as upload manifests for
 * the Claude-Agents-API deploy pipeline, but they are deliberately NOT
 * surfaced in the platform store (they were visible as "incompatible" during
 * the Odoo/Confluence migration; removed once those agents were migrated).
 *
 * The catalog is loaded once at startup and cached in memory. Middleware
 * restart is cheap enough that a file-watcher hot-reload stays out of scope.
 */

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
// `PLUGIN_MANIFEST_DIR` is set in the Docker image so the loader does not
// depend on the compiled-JS path resolving to the repo root (which it does in
// dev, but not in the production container where `middleware/` has been
// flattened into `/app/`). Falls back to the repo-root-relative path for dev.
const DEFAULT_MANIFEST_DIR =
  process.env['PLUGIN_MANIFEST_DIR'] ??
  path.join(REPO_ROOT, 'docs', 'harness-platform', 'examples');

export interface PluginCatalogOptions {
  manifestDir?: string;
  /** Additional manifest sources (e.g. extracted zip uploads). Each entry
   *  points at a package-root directory that contains a `manifest.yaml`.
   *  On ID collision with the built-in catalog the uploaded version wins. */
  extraSources?: () => Array<{ packageRoot: string }>;
}

export interface PluginCatalogEntry {
  plugin: Plugin;
  /** Parsed YAML document — returned verbatim for the detail endpoint. */
  manifest: unknown;
  /** Source file path, for diagnostics. */
  source_path: string;
  /** Loader that produced this entry. Only manifest-v1 is supported today. */
  source_kind: 'manifest-v1';
}

export class PluginCatalog {
  private entries = new Map<string, PluginCatalogEntry>();

  constructor(private readonly options: PluginCatalogOptions = {}) {}

  async load(): Promise<void> {
    const manifestDir = this.options.manifestDir ?? DEFAULT_MANIFEST_DIR;
    const manifestEntries = await loadManifestV1Entries(manifestDir);
    const next = new Map<string, PluginCatalogEntry>();
    for (const entry of manifestEntries) next.set(entry.plugin.id, entry);

    const extras = this.options.extraSources?.() ?? [];
    for (const src of extras) {
      const manifestPath = path.join(src.packageRoot, 'manifest.yaml');
      const entry = await loadManifestFromPath(manifestPath);
      if (entry) {
        next.set(entry.plugin.id, entry);
      } else {
        console.warn(
          `[catalog] skipped uploaded manifest at ${manifestPath}: not a recognised schema-v1 manifest`,
        );
      }
    }
    this.entries = next;
  }

  list(): PluginCatalogEntry[] {
    return Array.from(this.entries.values()).sort((a, b) =>
      a.plugin.name.localeCompare(b.plugin.name, 'de'),
    );
  }

  get(id: string): PluginCatalogEntry | undefined {
    return this.entries.get(id);
  }
}

/**
 * Loads a single `manifest.yaml` (e.g. from an uploaded package).
 * Returns `null` if the manifest does not match the schema — callers decide
 * whether that is a hard error (upload) or only gets logged (catalog scan).
 */
export async function loadManifestFromPath(
  absPath: string,
): Promise<PluginCatalogEntry | null> {
  try {
    const raw = await fs.readFile(absPath, 'utf-8');
    const doc = parseYaml(raw) as Record<string, unknown>;
    const plugin = adaptManifestV1(doc);
    if (!plugin) return null;
    return {
      plugin,
      manifest: doc,
      source_path: absPath,
      source_kind: 'manifest-v1',
    };
  } catch (err) {
    console.warn(`[catalog] failed to parse ${absPath}:`, err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Schema-v1 manifest loader
// ---------------------------------------------------------------------------

async function loadManifestV1Entries(
  dir: string,
): Promise<PluginCatalogEntry[]> {
  const files = await safeReadDir(dir);
  const manifestFiles = files.filter((f) => f.endsWith('.manifest.yaml'));
  const entries: PluginCatalogEntry[] = [];
  for (const name of manifestFiles) {
    const fullPath = path.join(dir, name);
    try {
      const raw = await fs.readFile(fullPath, 'utf-8');
      const doc = parseYaml(raw) as Record<string, unknown>;
      const plugin = adaptManifestV1(doc);
      if (plugin) {
        entries.push({
          plugin,
          manifest: doc,
          source_path: fullPath,
          source_kind: 'manifest-v1',
        });
      } else {
        console.warn(
          `[catalog] skipped ${fullPath}: not a recognised schema-v1 manifest`,
        );
      }
    } catch (err) {
      console.warn(`[catalog] failed to parse ${fullPath}:`, err);
    }
  }
  return entries;
}

export function adaptManifestV1(doc: Record<string, unknown>): Plugin | null {
  if (doc['schema_version'] !== '1') return null;

  const identity = asRecord(doc['identity']);
  if (!identity) return null;

  const id = asString(identity['id']);
  const name = asString(identity['name']);
  const version = asString(identity['version']);
  if (!id || !name || !version) return null;

  const compat = asRecord(doc['compat']);
  const setup = asRecord(doc['setup']);
  const permissions = asRecord(doc['permissions']);
  const integrations = asArray(doc['integrations']);

  const setupFields: PluginSetupField[] = [];
  const setupFieldsRaw = asArray(setup?.['fields']);
  for (const field of setupFieldsRaw) {
    const f = asRecord(field);
    if (!f) continue;
    const key = asString(f['key']);
    const type = asString(f['type']);
    if (!key || !type) continue;
    const label = asString(f['label']) ?? key;
    if (!isSetupFieldType(type)) continue;
    const entry: PluginSetupField = { key, label, type };
    const help = asString(f['help']);
    if (help) entry.help = help;
    const placeholder = asString(f['placeholder']);
    if (placeholder) entry.placeholder = placeholder;
    if (type === 'host_list') {
      // #91 Option B — the default for a host_list is an array of bare
      // hostnames, not a scalar string.
      const rawDefault = f['default'];
      if (Array.isArray(rawDefault)) {
        entry.default = rawDefault.filter(
          (h): h is string => typeof h === 'string',
        );
      }
    } else {
      const defaultValue = asString(f['default']);
      if (defaultValue !== undefined) entry.default = defaultValue;
    }
    if (type === 'enum') {
      const enumRaw = f['enum'];
      if (Array.isArray(enumRaw)) {
        const options: Array<{ value: string; label: string }> = [];
        for (const e of enumRaw) {
          const obj = asRecord(e);
          if (!obj) continue;
          const value = asString(obj['value']);
          if (!value) continue;
          options.push({ value, label: asString(obj['label']) ?? value });
        }
        if (options.length > 0) entry.enum = options;
      }
    }
    if (type === 'oauth') {
      // Spec 005 — the kernel broker resolves the descriptor (by `provider`)
      // and these scopes at flow time.
      const provider = asString(f['provider']);
      if (provider) entry.provider = provider;
      const scopesRaw = f['scopes'];
      if (Array.isArray(scopesRaw)) {
        const scopes = scopesRaw.filter(
          (s): s is string => typeof s === 'string',
        );
        if (scopes.length > 0) entry.scopes = scopes;
      }
    }
    // Dynamic post-install options (additive, lenient — any field type).
    const optionsProvider = asString(f['options_provider']);
    if (optionsProvider) entry.options_provider = optionsProvider;
    if (f['multi'] === true) entry.multi = true;
    setupFields.push(entry);
  }

  const rawKind = asString(identity['kind']);
  const kind: PluginKind =
    rawKind === 'integration'
      ? 'integration'
      : rawKind === 'channel'
        ? 'channel'
        : rawKind === 'tool'
          ? 'tool'
          : rawKind === 'extension'
            ? 'extension'
            : 'agent';
  const dependsOn = extractStringArray(doc['depends_on']);
  const jobs = extractJobs(doc['jobs']);
  const provides = extractCapabilityList(doc['provides'], id, 'provides');
  const requires = extractCapabilityList(doc['requires'], id, 'requires');
  const serviceTypes = extractServiceTypes(doc['service_types'], id);
  const channel =
    kind === 'channel' ? extractChannelBlock(doc['channel']) : undefined;
  // S+7.7 — plugins can ship their own operator-admin UI and announce
  // its mount path via top-level `admin_ui_path`. Web-dev embeds it as
  // an iframe on the store-detail page when plugin is 'active'. Path
  // is normalized to start with `/`.
  const adminUiPathRaw = asString(doc['admin_ui_path']);
  const adminUiPath = adminUiPathRaw
    ? adminUiPathRaw.startsWith('/')
      ? adminUiPathRaw
      : `/${adminUiPathRaw}`
    : undefined;

  // OB-29-0 — top-level `is_reference_only: true` flags Builder-Reference
  // plugins so the Operator-Plugin-Catalog filters them out. The
  // BuilderAgent reaches them via BUILDER_REFERENCE_ESSENTIALS instead.
  const isReferenceOnly = doc['is_reference_only'] === true;

  // OB-77 (Palaia Phase 8) — extract + validate `identity.domain`. Required
  // at the manifest level; we warn + auto-fallback to `unknown.<id>` rather
  // than fail-fast so a bad manifest can't deadlock the live middleware
  // (the operator sees the warning in the boot log and on the Admin UI).
  const domainCheck = validatePluginDomain(identity['domain']);
  let domain: string;
  if (domainCheck.ok) {
    domain = domainCheck.domain;
  } else {
    // Build a regex-valid fallback: split on dots, strip non-alphanumerics
    // per segment, drop empty segments, prefix with `unknown.`. Plugin ids
    // like `@omadia/plugin-web-search` collapse to `unknown.de.byte5.tool.websearch`.
    const safeSegments = id
      .toLowerCase()
      .split(/[./]/)
      .map((p) => p.replace(/[^a-z0-9]/g, ''))
      .filter((p) => p.length > 0 && /^[a-z]/.test(p));
    const safeId = safeSegments.length > 0 ? safeSegments.join('.') : 'plugin';
    domain = `unknown.${safeId}`;
    console.warn(
      `[manifest:${id}] domain ${domainCheck.message} — auto-fallback to "${domain}". Add identity.domain (e.g. "confluence", "odoo.hr") to the plugin's manifest.yaml.`,
    );
  }

  // Multi-orchestrator runtime (US1) — multi-instance safety + privacy
  // class. Both default permissively so a manifest without them still
  // loads; invalid values warn and fall back, matching this loader's
  // graceful-degradation contract.
  const multiInstance = doc['multi_instance'] === false ? false : true;
  const multiInstanceJustification = asString(
    doc['multi_instance_justification'],
  );
  if (multiInstance === false && !multiInstanceJustification) {
    console.warn(
      `[manifest:${id}] multi_instance is false but multi_instance_justification is missing — add a non-empty reason to the plugin's manifest.yaml.`,
    );
  }
  const privacyClassRaw = asString(doc['privacy_class']);
  if (
    privacyClassRaw !== undefined &&
    privacyClassRaw !== 'strict' &&
    privacyClassRaw !== 'default'
  ) {
    console.warn(
      `[manifest:${id}] privacy_class '${privacyClassRaw}' is not 'strict' or 'default' — falling back to 'default'.`,
    );
  }
  const privacyClass: 'strict' | 'default' =
    privacyClassRaw === 'strict' ? 'strict' : 'default';

  const setupGuide = asLocalizedGuide(setup?.['guide']);

  // Spec 005 — declarative OAuth-provider descriptors. Inert data the kernel
  // broker reads at flow time; no plugin code runs during the OAuth dance.
  const oauthProviders = extractOAuthProviders(doc['oauth_providers'], id);
  const permissionsSummary = extractPermissions(permissions);
  if (oauthProviders.length > 0) {
    permissionsSummary.acquires_oauth = true;
  }

  const base: Plugin = {
    id,
    kind,
    name,
    version,
    latest_version: version,
    description: asString(identity['description']) ?? '',
    authors: extractAuthors(identity['authors']),
    license: asString(identity['license']) ?? 'Unknown',
    icon_url: null,
    categories: extractStringArray(identity['categories']),
    domain,
    compat_core: asString(compat?.['core']) ?? '>=1.0 <2.0',
    signed: false,
    signed_by: null,
    setup_fields: setupFields,
    permissions_summary: permissionsSummary,
    integrations_summary: extractIntegrationTargets(integrations),
    install_state: 'available',
    depends_on: dependsOn,
    jobs,
    provides,
    requires,
    multi_instance: multiInstance,
    privacy_class: privacyClass,
  };
  let result: Plugin = base;
  if (oauthProviders.length > 0) {
    result = { ...result, oauth_providers: oauthProviders };
  }
  if (serviceTypes.length > 0) {
    result = { ...result, service_types: serviceTypes };
  }
  if (setupGuide) result = { ...result, setup_guide: setupGuide };
  if (channel) result = { ...result, channel };
  if (adminUiPath) result = { ...result, admin_ui_path: adminUiPath };
  if (isReferenceOnly) result = { ...result, is_reference_only: true };
  if (multiInstanceJustification) {
    result = {
      ...result,
      multi_instance_justification: multiInstanceJustification,
    };
  }
  return result;
}

/**
 * Parses a `provides:` or `requires:` array. Each entry must be a non-empty
 * string that {@link parseCapabilityRef} accepts. Malformed entries are
 * dropped with a `console.warn` so that one bad manifest doesn't break
 * catalog-load for the rest; the capability resolver additionally re-parses
 * at activation time and surfaces a hard error if a `requires` has no
 * provider — so dropping here is safe from a correctness standpoint.
 */
function extractCapabilityList(
  raw: unknown,
  pluginId: string,
  field: 'provides' | 'requires',
): string[] {
  const arr = asArray(raw);
  const out: string[] = [];
  for (const item of arr) {
    if (typeof item !== 'string') continue;
    try {
      parseCapabilityRef(item);
      out.push(item.trim());
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[catalog] plugin '${pluginId}' ${field}: ${msg} (entry dropped)`,
      );
    }
  }
  return out;
}

/**
 * Parses the `service_types:` array from an integration manifest. Each entry
 * is `{service: string, type: {from: string, name: string}}`. These map a
 * plugin-published `ctx.services.provide(...)` surface to the TypeScript type
 * a consuming agent imports — the kernel registers them into the agent-
 * builder's `serviceTypeRegistry` on activation (see index.ts wiring).
 *
 * Malformed entries (missing/empty `service`, `type.from`, or `type.name`)
 * are dropped with a `console.warn`, matching this loader's graceful-
 * degradation contract: one bad entry must not break catalog-load for the
 * rest of the manifest. A wholly-absent block yields `[]`.
 */
function extractServiceTypes(
  raw: unknown,
  pluginId: string,
): ServiceTypeDecl[] {
  const arr = asArray(raw);
  const out: ServiceTypeDecl[] = [];
  for (const item of arr) {
    const r = asRecord(item);
    if (!r) continue;
    const service = asString(r['service'])?.trim();
    const type = asRecord(r['type']);
    const from = asString(type?.['from'])?.trim();
    const name = asString(type?.['name'])?.trim();
    if (!service || !from || !name) {
      console.warn(
        `[catalog] plugin '${pluginId}' service_types: entry must have ` +
          `non-empty 'service', 'type.from', and 'type.name' (entry dropped)`,
      );
      continue;
    }
    out.push({ service, type: { from, name } });
  }
  return out;
}

/**
 * Parses the `jobs:` array from a manifest. Each entry is `{name, schedule,
 * timeout_ms?, overlap?}`. `schedule` is either a string (5- or 6-field cron
 * expression in croner syntax) which becomes `{cron: <string>}`, or an
 * object `{intervalMs: <number>}`. Malformed entries (missing name, both
 * cron+intervalMs, neither) are silently dropped here — the JobScheduler
 * additionally validates at registration time and surfaces a runtime error.
 * The two layers are intentionally redundant: the catalog skip keeps a
 * malformed manifest from breaking the whole catalog load, while the
 * scheduler check guards programmatic `ctx.jobs.register` callers too.
 */
function extractJobs(raw: unknown): PluginJobSpec[] {
  const arr = asArray(raw);
  const out: PluginJobSpec[] = [];
  for (const item of arr) {
    const r = asRecord(item);
    if (!r) continue;
    const name = asString(r['name']);
    if (!name) continue;
    const schedule = parseJobSchedule(r['schedule']);
    if (!schedule) continue;
    const job: PluginJobSpec = { name, schedule };
    const timeoutMs = r['timeout_ms'];
    if (typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0) {
      job.timeout_ms = timeoutMs;
    }
    const overlap = r['overlap'];
    if (overlap === 'skip' || overlap === 'queue') {
      job.overlap = overlap;
    }
    out.push(job);
  }
  return out;
}

function parseJobSchedule(raw: unknown): PluginJobSchedule | null {
  if (typeof raw === 'string' && raw.trim().length > 0) {
    return { cron: raw.trim() };
  }
  const r = asRecord(raw);
  if (!r) return null;
  const cron = asString(r['cron']);
  if (cron) return { cron };
  const intervalMs = r['intervalMs'] ?? r['interval_ms'];
  if (typeof intervalMs === 'number' && Number.isFinite(intervalMs) && intervalMs > 0) {
    return { intervalMs };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Channel block parsing (schema v1.2, section 14)
// ---------------------------------------------------------------------------

const CHANNEL_TRANSPORT_KINDS: ReadonlySet<ChannelTransportKind> = new Set([
  'webhook',
  'websocket',
  'long-poll',
]);

const CHANNEL_CAPABILITIES: ReadonlySet<ChannelCapability> = new Set([
  'text',
  'attachments',
  'interactive_cards',
  'user_sso',
  'file_upload',
  'typing_indicator',
  'canvas',
]);

const CHANNEL_ADAPTERS: ReadonlySet<ChannelAdapter> = new Set([
  'text',
  'markdown',
  'adaptive_card',
  'block_kit',
  'interactive_message',
  'discord_components',
  'telegram_keyboard',
]);

function extractChannelBlock(
  raw: unknown,
): ChannelManifestBlock | undefined {
  const rec = asRecord(raw);
  if (!rec) return undefined;

  const transportRec = asRecord(rec['transport']);
  if (!transportRec) return undefined;
  const transportKindRaw = asString(transportRec['kind']);
  if (
    !transportKindRaw ||
    !CHANNEL_TRANSPORT_KINDS.has(transportKindRaw as ChannelTransportKind)
  ) {
    return undefined;
  }
  const transportKind = transportKindRaw as ChannelTransportKind;

  const routes: ChannelTransportRoute[] = [];
  for (const routeEntry of asArray(transportRec['routes'])) {
    const routeRec = asRecord(routeEntry);
    if (!routeRec) continue;
    const path = asString(routeRec['path']);
    const method = asString(routeRec['method']);
    if (!path || !method) continue;
    routes.push({ path, method });
  }

  const verifySignature = transportRec['verify_signature'] === true;

  const capabilities: ChannelCapability[] = [];
  for (const cap of asArray(rec['capabilities'])) {
    if (typeof cap !== 'string') continue;
    if (CHANNEL_CAPABILITIES.has(cap as ChannelCapability)) {
      capabilities.push(cap as ChannelCapability);
    }
  }

  const adapters: ChannelAdapter[] = [];
  for (const adapter of asArray(rec['adapters'])) {
    if (typeof adapter !== 'string') continue;
    if (CHANNEL_ADAPTERS.has(adapter as ChannelAdapter)) {
      adapters.push(adapter as ChannelAdapter);
    }
  }

  // Omadia UI (additive): optional canvas-channel fields. Classic channels
  // omit both; absent `dispatch_service` falls back to 'chatAgent' at dispatch.
  const dispatchService = asString(rec['dispatch_service']);
  const canvasProtocolVersion = asString(rec['canvas_protocol_version']);

  return {
    transport: {
      kind: transportKind,
      routes,
      verify_signature: verifySignature,
    },
    capabilities,
    adapters,
    ...(dispatchService ? { dispatch_service: dispatchService } : {}),
    ...(canvasProtocolVersion
      ? { canvas_protocol_version: canvasProtocolVersion }
      : {}),
  };
}

function extractPermissions(
  permissions: Record<string, unknown> | undefined,
): PluginPermissionsSummary {
  const memory = asRecord(permissions?.['memory']);
  const graph = asRecord(permissions?.['graph']);
  const network = asRecord(permissions?.['network']);
  const rawAuditMode = network?.['audit_mode'];
  const subAgents = asRecord(permissions?.['subAgents']);
  // OB-29-1: per-tool-handler invocation budget. Default 5 when missing,
  // negative or non-integer values are clamped to 0 (effectively no calls).
  const rawBudget = subAgents?.['calls_per_invocation'];
  const parsedBudget =
    typeof rawBudget === 'number' && Number.isFinite(rawBudget)
      ? Math.max(0, Math.floor(rawBudget))
      : 5;
  // OB-29-2 — strip the host-reserved system namespaces. Plugin-side ingest
  // for 'odoo'/'confluence' is rejected by the underlying schema anyway,
  // but filtering here makes the audit-summary truthful (operator sees
  // exactly what the plugin can write, not what the plugin asked for).
  const RESERVED_SYSTEMS = new Set(['odoo', 'confluence']);
  const entitySystems = extractStringArray(graph?.['entity_systems']).filter(
    (s) => !RESERVED_SYSTEMS.has(s),
  );
  // OB-29-3 — LLM permissions.
  const llm = asRecord(permissions?.['llm']);
  const llmModelsAllowed = extractStringArray(llm?.['models_allowed']);
  const llmCallsRaw = llm?.['calls_per_invocation'];
  const llmCallsPerInvocation =
    typeof llmCallsRaw === 'number' && Number.isFinite(llmCallsRaw)
      ? Math.max(0, Math.floor(llmCallsRaw))
      : 5;
  const llmTokensRaw = llm?.['max_tokens_per_call'];
  const llmMaxTokensPerCall =
    typeof llmTokensRaw === 'number' && Number.isFinite(llmTokensRaw)
      ? Math.max(1, Math.floor(llmTokensRaw))
      : 4096;
  // Spec 004 — runtime credential write + flow toolkit gates.
  const secretsBlock = asRecord(permissions?.['secrets']);
  return {
    memory_reads: extractStringArray(memory?.['reads']),
    memory_writes: extractStringArray(memory?.['writes']),
    graph_reads: extractStringArray(graph?.['reads']),
    graph_writes: extractStringArray(graph?.['writes']),
    network_outbound: extractStringArray(network?.['outbound']),
    network_web_scanner: network?.['web_scanner'] === true,
    network_default_audit_mode:
      rawAuditMode === 'single-host' ||
      rawAuditMode === 'allowlist' ||
      rawAuditMode === 'public-web'
        ? rawAuditMode
        : undefined,
    sub_agents_calls: extractStringArray(subAgents?.['calls']),
    sub_agents_calls_per_invocation: parsedBudget,
    graph_entity_systems: entitySystems,
    llm_models_allowed: llmModelsAllowed,
    llm_calls_per_invocation: llmCallsPerInvocation,
    llm_max_tokens_per_call: llmMaxTokensPerCall,
    secrets_runtime_write: secretsBlock?.['runtime_write'] === true,
    flows: permissions?.['flows'] === true,
    // Spec 005 (US4 Conductor Surface) — plugin may emit declared domain events via ctx.events.emit.
    events_emit: asRecord(permissions?.['events'])?.['emit'] === true,
    // Spec 005 — overridden to true in adaptManifestV1 when the manifest
    // declares >=1 valid oauth_providers descriptor.
    acquires_oauth: false,
  };
}

/**
 * Spec 005 — parse + validate the top-level `oauth_providers:` block. Each
 * descriptor must carry id/authorize_url/token_url/client_id_field/
 * client_secret_field and a valid `token_auth_style`; malformed entries are
 * dropped with a `console.warn` (graceful-degradation, matching the rest of
 * this loader). `pkce` defaults to true; `extra_authorize_params` keeps only
 * string-valued entries. The descriptor is inert data — the kernel OAuth
 * engine executes it, so no plugin code touches the flow.
 */
function extractOAuthProviders(
  raw: unknown,
  pluginId: string,
): OAuthProviderDescriptor[] {
  const out: OAuthProviderDescriptor[] = [];
  for (const entry of asArray(raw)) {
    const rec = asRecord(entry);
    if (!rec) continue;
    const id = asString(rec['id']);
    const authorizeUrl = asString(rec['authorize_url']);
    const tokenUrl = asString(rec['token_url']);
    const clientIdField = asString(rec['client_id_field']);
    const clientSecretField = asString(rec['client_secret_field']);
    if (
      !id ||
      !authorizeUrl ||
      !tokenUrl ||
      !clientIdField ||
      !clientSecretField
    ) {
      console.warn(
        `[manifest:${pluginId}] oauth_provider dropped — requires id, authorize_url, token_url, client_id_field and client_secret_field.`,
      );
      continue;
    }
    const style = asString(rec['token_auth_style']);
    if (style !== 'body_form' && style !== 'body_json' && style !== 'basic') {
      console.warn(
        `[manifest:${pluginId}] oauth_provider '${id}' dropped — token_auth_style '${style ?? ''}' is not body_form|body_json|basic.`,
      );
      continue;
    }
    const descriptor: OAuthProviderDescriptor = {
      id,
      authorize_url: authorizeUrl,
      token_url: tokenUrl,
      token_auth_style: style,
      pkce: rec['pkce'] !== false,
      client_id_field: clientIdField,
      client_secret_field: clientSecretField,
    };
    const extra = asRecord(rec['extra_authorize_params']);
    if (extra) {
      const params: Record<string, string> = {};
      for (const [k, v] of Object.entries(extra)) {
        if (typeof v === 'string') params[k] = v;
      }
      if (Object.keys(params).length > 0) {
        descriptor.extra_authorize_params = params;
      }
    }
    out.push(descriptor);
  }
  return out;
}

function extractIntegrationTargets(integrations: unknown[]): string[] {
  const out: string[] = [];
  for (const entry of integrations) {
    const rec = asRecord(entry);
    if (!rec) continue;
    const target = asString(rec['target']);
    if (target) out.push(target);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

async function safeReadDir(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      console.warn(`[catalog] directory does not exist, skipping: ${dir}`);
      return [];
    }
    throw err;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Normalise a manifest `setup.guide` into a `{ <locale>: markdown }` map.
 * Accepts the canonical object form (`{ en: "…", de: "…" }`) and tolerates a
 * bare string (treated as English). Empty strings and non-string values are
 * dropped; returns undefined when nothing usable remains.
 */
function asLocalizedGuide(value: unknown): Record<string, string> | undefined {
  if (typeof value === 'string') {
    const s = value.trim();
    return s.length > 0 ? { en: value } : undefined;
  }
  const rec = asRecord(value);
  if (!rec) return undefined;
  const out: Record<string, string> = {};
  for (const [locale, text] of Object.entries(rec)) {
    if (typeof text === 'string' && text.trim().length > 0) out[locale] = text;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function extractStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}

function extractAuthors(
  value: unknown,
): Array<{ name: string; email?: string; url?: string }> {
  if (!Array.isArray(value)) return [];
  const out: Array<{ name: string; email?: string; url?: string }> = [];
  for (const entry of value) {
    const rec = asRecord(entry);
    if (!rec) continue;
    const name = asString(rec['name']);
    if (!name) continue;
    const author: { name: string; email?: string; url?: string } = { name };
    const email = asString(rec['email']);
    if (email) author.email = email;
    const url = asString(rec['url']);
    if (url) author.url = url;
    out.push(author);
  }
  return out;
}

function isSetupFieldType(value: string): value is PluginSetupField['type'] {
  return (
    value === 'string' ||
    value === 'url' ||
    value === 'secret' ||
    value === 'oauth' ||
    value === 'enum' ||
    value === 'boolean' ||
    value === 'integer' ||
    value === 'host_list'
  );
}
