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
  Plugin,
  PluginJobSchedule,
  PluginJobSpec,
  PluginKind,
  PluginPermissionsSummary,
  PluginSetupField,
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
  /** Zusätzliche Manifest-Quellen (z.B. entpackte Zip-Uploads). Jeder Eintrag
   *  zeigt auf ein Package-Root-Verzeichnis, das eine `manifest.yaml` enthält.
   *  Bei ID-Kollision mit dem Built-in-Katalog gewinnt die Uploaded-Version. */
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
 * Lädt ein einzelnes `manifest.yaml` (z.B. aus einem hochgeladenen Package).
 * Gibt `null` zurück, wenn das Manifest nicht dem Schema entspricht — Caller
 * entscheiden, ob das ein harter Fehler ist (Upload) oder nur geloggt wird
 * (Catalog-Scan).
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

function adaptManifestV1(doc: Record<string, unknown>): Plugin | null {
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

  const requiredSecrets: PluginSetupField[] = [];
  const setupFields = asArray(setup?.['fields']);
  for (const field of setupFields) {
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
    const defaultValue = asString(f['default']);
    if (defaultValue !== undefined) entry.default = defaultValue;
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
    requiredSecrets.push(entry);
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
    required_secrets: requiredSecrets,
    permissions_summary: extractPermissions(permissions),
    integrations_summary: extractIntegrationTargets(integrations),
    install_state: 'available',
    depends_on: dependsOn,
    jobs,
    provides,
    requires,
  };
  let result: Plugin = base;
  if (channel) result = { ...result, channel };
  if (adminUiPath) result = { ...result, admin_ui_path: adminUiPath };
  if (isReferenceOnly) result = { ...result, is_reference_only: true };
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

  return {
    transport: {
      kind: transportKind,
      routes,
      verify_signature: verifySignature,
    },
    capabilities,
    adapters,
  };
}

function extractPermissions(
  permissions: Record<string, unknown> | undefined,
): PluginPermissionsSummary {
  const memory = asRecord(permissions?.['memory']);
  const graph = asRecord(permissions?.['graph']);
  const network = asRecord(permissions?.['network']);
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
  return {
    memory_reads: extractStringArray(memory?.['reads']),
    memory_writes: extractStringArray(memory?.['writes']),
    graph_reads: extractStringArray(graph?.['reads']),
    graph_writes: extractStringArray(graph?.['writes']),
    network_outbound: extractStringArray(network?.['outbound']),
    sub_agents_calls: extractStringArray(subAgents?.['calls']),
    sub_agents_calls_per_invocation: parsedBudget,
    graph_entity_systems: entitySystems,
    llm_models_allowed: llmModelsAllowed,
    llm_calls_per_invocation: llmCallsPerInvocation,
    llm_max_tokens_per_call: llmMaxTokensPerCall,
  };
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
    value === 'integer'
  );
}
