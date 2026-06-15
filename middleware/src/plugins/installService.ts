import { randomUUID } from 'node:crypto';

import {
  PRIVACY_BYPASS_SCOPES_CONFIG_KEY,
  PRIVACY_MODE_CONFIG_KEY,
  PRIVACY_MODE_DEFAULT,
  PRIVACY_MODE_VALUES,
} from '@omadia/plugin-api';

import type {
  ApiError,
  InstallJob,
  InstallJobState,
  InstallSetupField,
  InstallSetupSchema,
} from '../api/admin-v1.js';
import type { SecretVault } from '../secrets/vault.js';
import {
  findActiveProviderCollision,
  walkCapabilityInstallChain,
} from './capabilityResolver.js';
import type { InstalledRegistry } from './installedRegistry.js';
import type { PluginCatalog, PluginCatalogEntry } from './manifestLoader.js';

export interface InstallServiceDeps {
  catalog: PluginCatalog;
  registry: InstalledRegistry;
  vault: SecretVault;
  /** Called after a successful `configure()` — e.g. to activate an uploaded
   *  agent via DynamicAgentRuntime. Errors in the hook do not cause the
   *  installation to be marked `failed`: registry entries are already
   *  persisted and the agent counts as installed. The caller must handle
   *  hook errors separately. */
  onInstalled?: (agentId: string) => Promise<void>;
  /** Counterpart to `onInstalled`: called in the uninstall path BEFORE the
   *  removal from registry/vault, so the runtime can deactivate cleanly. */
  onUninstall?: (agentId: string) => Promise<void>;
}

/**
 * Service layer for the install flow. HTTP routes delegate to this; the
 * business logic (validation, vault/registry writes, state transitions)
 * lives here, so we can call it from tests or future CLIs without touching
 * Express.
 *
 * Slice 1.2a scope: synchronous jobs with two meaningful states —
 * `awaiting_config` after creation, `active` after successful configure.
 * SSE progress, persistent jobs, and self-test hooks arrive in 1.2b.
 */
export class InstallService {
  private readonly jobs = new Map<string, InstallJob>();

  constructor(private readonly deps: InstallServiceDeps) {}

  // -------------------------------------------------------------------------
  // Create — derives the setup schema from the plugin manifest
  // -------------------------------------------------------------------------

  create(pluginId: string): InstallJob {
    const entry = this.deps.catalog.get(pluginId);
    if (!entry) {
      throw new InstallError(
        'store.plugin_not_found',
        `no plugin with id '${pluginId}'`,
        404,
      );
    }

    if (this.deps.registry.has(pluginId)) {
      throw new InstallError(
        'install.already_installed',
        `plugin '${pluginId}' is already installed; uninstall first`,
        409,
      );
    }

    if (entry.plugin.install_state === 'incompatible') {
      throw new InstallError(
        'install.blocked',
        entry.plugin.incompatibility_reasons?.join('; ') ??
          'plugin is marked incompatible',
        409,
      );
    }

    // Dependency gate: every parent in depends_on must already be installed.
    // The UI can chain installs, but the service stays strict — it refuses a
    // job that would leave a dangling reference.
    const missingParents = entry.plugin.depends_on.filter(
      (parentId) => !this.deps.registry.has(parentId),
    );
    if (missingParents.length > 0) {
      throw new InstallError(
        'install.missing_dependencies',
        `plugin requires these parents to be installed first: ${missingParents.join(', ')}`,
        409,
      );
    }

    // Provider-collision gate: if the candidate's `provides` overlaps a
    // `<name>@<major>` already published by an active installed plugin,
    // refuse the install. Without this gate the registry can persist two
    // active providers for the same capability — boot then crashes in
    // `buildProviderIndex` (capabilityResolver.ts) with no automatic
    // recovery, because the kernel has no operator-intent signal to pick
    // a winner. The operator must uninstall the existing provider first.
    const collision = findActiveProviderCollision(
      pluginId,
      this.deps.catalog,
      this.deps.registry,
    );
    if (collision) {
      throw new InstallError(
        'install.capability_already_provided',
        `capability '${collision.capability}' is already provided by '${collision.ownerId}' — uninstall it first`,
        409,
        collision,
      );
    }

    // Capability gate: walk the requires-chain transitively against the
    // catalog and reject if any cap lacks an active provider. The
    // response carries `details.available_providers` so the operator
    // wizard can do a single chained install (provider(s) → target) in
    // topo-order. Server-side and complete — frontend never recomputes
    // the chain.
    const chain = walkCapabilityInstallChain(
      pluginId,
      this.deps.catalog,
      this.deps.registry,
    );
    if (chain.unresolved_requires.length > 0) {
      throw new InstallError(
        'install.missing_capability',
        `plugin requires capabilities not yet provided: ${chain.unresolved_requires.join(', ')}`,
        409,
        chain,
      );
    }

    const setupSchema = extractSetupSchema(entry);

    const now = new Date().toISOString();
    const job: InstallJob = {
      id: randomUUID(),
      plugin_id: pluginId,
      plugin_version: entry.plugin.version,
      state: 'awaiting_config',
      current_step: 'Warte auf Konfiguration',
      error: null,
      setup_schema: setupSchema,
      created_at: now,
      updated_at: now,
    };
    this.jobs.set(job.id, job);
    return job;
  }

  // -------------------------------------------------------------------------
  // Get
  // -------------------------------------------------------------------------

  get(jobId: string): InstallJob {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new InstallError(
        'install.job_not_found',
        `no job with id '${jobId}'`,
        404,
      );
    }
    return job;
  }

  // -------------------------------------------------------------------------
  // Configure — validates, splits secrets vs config, persists, activates
  // -------------------------------------------------------------------------

  async configure(
    jobId: string,
    values: Record<string, unknown>,
  ): Promise<InstallJob> {
    const job = this.get(jobId);

    if (job.state !== 'awaiting_config') {
      throw new InstallError(
        'install.wrong_state',
        `job is in state '${job.state}', expected 'awaiting_config'`,
        409,
      );
    }

    const schema = job.setup_schema;
    if (!schema) {
      throw new InstallError(
        'install.no_schema',
        'job has no setup_schema — cannot configure',
        500,
      );
    }

    this.transition(job, 'configuring', 'Validiere Eingaben');

    const validated = validateValues(schema, values);
    if (validated.errors.length > 0) {
      this.fail(job, {
        code: 'install.validation_failed',
        message: 'Eingaben enthalten Fehler',
        details: validated.errors,
      });
      return job;
    }

    const { secrets, config } = splitSecretsAndConfig(
      schema,
      validated.values,
    );

    try {
      if (Object.keys(secrets).length > 0) {
        await this.deps.vault.setMany(job.plugin_id, secrets);
      }
      await this.deps.registry.register({
        id: job.plugin_id,
        installed_version: job.plugin_version,
        installed_at: new Date().toISOString(),
        status: 'active',
        config,
      });
      this.transition(job, 'active', 'Installation abgeschlossen');

      if (this.deps.onInstalled) {
        try {
          await this.deps.onInstalled(job.plugin_id);
        } catch (err) {
          console.error(
            `[install] onInstalled hook failed for ${job.plugin_id}:`,
            err instanceof Error ? err.message : err,
          );
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.fail(job, {
        code: 'install.write_failed',
        message,
      });
    }

    return job;
  }

  // -------------------------------------------------------------------------
  // Uninstall — reverses `configure()`:
  //   1) onUninstall hook (runtime: close handle, unregister domain tool)
  //   2) vault.purge (namespace deleted)
  //   3) registry.remove (installed → available)
  //
  // Dependents check: if another installed agent points at this one via
  // `depends_on`, the call is rejected with 409. The caller (UI) must
  // uninstall the dependent first.
  // -------------------------------------------------------------------------

  /**
   * Reapply the install hooks for an already-installed plugin: tear the
   * current runtime instance down via `onUninstall`, then bring it back up
   * via `onInstalled`. The registry entry, vault secrets, and config stay
   * untouched — this is the "config changed, please re-read it" path used
   * by the post-install config-editor.
   *
   * Many plugins cache their config at `activate()` time (closures around
   * endpoint URLs, timeouts, model IDs). Without a re-activation, edits in
   * the Store UI sit in the registry but the running plugin instance keeps
   * using the boot-time values.
   *
   * No-op if the plugin is not installed. Hook errors are logged but not
   * re-thrown: a stuck old instance is better than a hard failure that
   * blocks the operator from saving config.
   */
  async reactivate(agentId: string): Promise<void> {
    if (!this.deps.registry.has(agentId)) return;
    if (this.deps.onUninstall) {
      try {
        await this.deps.onUninstall(agentId);
      } catch (err) {
        console.error(
          `[install] reactivate.onUninstall hook failed for ${agentId}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
    if (this.deps.onInstalled) {
      try {
        await this.deps.onInstalled(agentId);
      } catch (err) {
        console.error(
          `[install] reactivate.onInstalled hook failed for ${agentId}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

  async uninstall(agentId: string): Promise<void> {
    if (!this.deps.registry.has(agentId)) {
      throw new InstallError(
        'install.not_installed',
        `plugin '${agentId}' is not installed`,
        404,
      );
    }

    const dependents = this.findDependents(agentId);
    if (dependents.length > 0) {
      throw new InstallError(
        'install.has_dependents',
        `cannot uninstall — still required by: ${dependents.join(', ')}`,
        409,
      );
    }

    // Remove from all open jobs so the re-install path is clean.
    for (const [jobId, job] of this.jobs) {
      if (job.plugin_id === agentId && job.state !== 'active') {
        this.jobs.delete(jobId);
      }
    }

    if (this.deps.onUninstall) {
      try {
        await this.deps.onUninstall(agentId);
      } catch (err) {
        console.error(
          `[install] onUninstall hook failed for ${agentId}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    try {
      await this.deps.vault.purge(agentId);
    } catch (err) {
      console.error(
        `[install] vault.purge failed for ${agentId}:`,
        err instanceof Error ? err.message : err,
      );
    }
    await this.deps.registry.remove(agentId);
  }

  private findDependents(parentId: string): string[] {
    const dependents: string[] = [];
    for (const installed of this.deps.registry.list()) {
      if (installed.id === parentId) continue;
      const entry = this.deps.catalog.get(installed.id);
      if (!entry) continue;
      if (entry.plugin.depends_on.includes(parentId)) {
        dependents.push(installed.id);
      }
    }
    return dependents;
  }

  // -------------------------------------------------------------------------
  // Cancel
  // -------------------------------------------------------------------------

  cancel(jobId: string): InstallJob {
    const job = this.get(jobId);
    if (job.state === 'active' || job.state === 'cancelled') {
      return job;
    }
    this.transition(job, 'cancelled', 'Vom Nutzer abgebrochen');
    return job;
  }

  // -------------------------------------------------------------------------
  // internal state helpers
  // -------------------------------------------------------------------------

  private transition(
    job: InstallJob,
    state: InstallJobState,
    step: string,
  ): void {
    job.state = state;
    job.current_step = step;
    job.updated_at = new Date().toISOString();
  }

  private fail(job: InstallJob, error: ApiError): void {
    job.state = 'failed';
    job.current_step = 'Fehlgeschlagen';
    job.error = error;
    job.updated_at = new Date().toISOString();
  }
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class InstallError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    /** Structured payload propagated as `details` on the HTTP response.
     *  Used by `install.missing_capability` to ship the
     *  `available_providers` chain so the wizard can issue a chained
     *  install without recomputing on the client. */
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'InstallError';
  }
}

// ---------------------------------------------------------------------------
// Manifest → SetupSchema
// ---------------------------------------------------------------------------

export function extractSetupSchema(
  entry: PluginCatalogEntry,
): InstallSetupSchema | null {
  // Legacy manifests expose no setup block — they can still be "installed"
  // in 1.2a with empty config so the flow is exercisable end-to-end.
  const manifest = entry.manifest;
  if (!manifest || typeof manifest !== 'object') {
    return { fields: [] };
  }
  const setup = (manifest as Record<string, unknown>)['setup'];
  if (!setup || typeof setup !== 'object') {
    return { fields: [] };
  }
  const fieldsRaw = (setup as Record<string, unknown>)['fields'];
  if (!Array.isArray(fieldsRaw)) {
    return { fields: [] };
  }
  const fields: InstallSetupField[] = [];
  for (const raw of fieldsRaw) {
    if (!raw || typeof raw !== 'object') continue;
    const f = raw as Record<string, unknown>;
    const key = asString(f['key']);
    const type = asString(f['type']);
    if (!key || !type || !isSupportedType(type)) continue;
    const field: InstallSetupField = {
      key,
      type,
      label: asString(f['label']) ?? key,
      required: f['required'] !== false,
    };
    const help = asString(f['help']);
    if (help) field.help = help;
    if (f['default'] !== undefined) field.default = f['default'];
    const pattern = asString(f['pattern']);
    if (pattern) field.pattern = pattern;
    if ((type === 'string' || type === 'secret') && f['multiline'] === true) {
      field.multiline = true;
    }
    if (type === 'enum') {
      const enumRaw = f['enum'];
      if (Array.isArray(enumRaw)) {
        const options: Array<{ value: string; label: string }> = [];
        for (const e of enumRaw) {
          if (!e || typeof e !== 'object') continue;
          const obj = e as Record<string, unknown>;
          const value = asString(obj['value']);
          if (!value) continue;
          options.push({
            value,
            label: asString(obj['label']) ?? value,
          });
        }
        field.enum = options;
      }
    }
    if (type === 'oauth') {
      const provider = asString(f['provider']);
      if (provider) field.provider = provider;
      const scopesRaw = f['scopes'];
      if (Array.isArray(scopesRaw)) {
        field.scopes = scopesRaw.filter(
          (s): s is string => typeof s === 'string',
        );
      }
    }
    fields.push(field);
  }
  // Slice 2.5 — kernel-injected synthetic `_privacy_mode` field. Appears
  // on every plugin's install form regardless of whether the manifest
  // declares it. The operator picks how the orchestrator's dispatch hook
  // should treat raw tool results from this plugin (`guarded` default,
  // `bypass`, or `per_tool` for the advanced override). The chosen value
  // lands in `installedRegistry.get(id).config['_privacy_mode']` via the
  // standard `configure()` validation path and is read back at dispatch
  // time by the orchestrator's `resolveBypass` resolver.
  //
  // Skipped for plugins that contribute no tools — they have nothing to
  // privacy-route. We approximate "contributes tools" as "any catalog
  // entry whose manifest has a non-empty `tools` block or whose `kind`
  // is `tool` / `integration` / `agent`". Channels with kind `channel`
  // do not contribute LLM-visible tools and skip the field.
  if (pluginContributesTools(entry)) {
    fields.push(privacyModeField(entry));
    // Slice 2.5d — per-tool whitelist for advanced operators. Consulted
    // by `resolveEffectivePrivacyMode` only when `_privacy_mode = 'per_tool'`;
    // the resolver tolerates both comma-separated strings (manual entry)
    // and arrays (programmatic API). Optional string field — operators
    // using `guarded` or `bypass` simply leave it empty.
    fields.push(privacyBypassScopesField());
  }
  return { fields };
}

function pluginContributesTools(entry: PluginCatalogEntry): boolean {
  const manifest = entry.manifest as Record<string, unknown> | undefined;
  if (!manifest) return false;
  const kind = typeof manifest['kind'] === 'string' ? manifest['kind'] : '';
  // Channels never expose LLM-callable tools; everything else may. We
  // err on the inclusive side — adding a guarded-by-default dropdown
  // to a plugin without tools is harmless (the dispatch hook simply
  // never consults it). Excluding channels keeps the install UI tidy
  // for the most common no-tool case.
  return kind !== 'channel';
}

function privacyModeField(entry: PluginCatalogEntry): InstallSetupField {
  const baseHelp =
    'Wie behandelt der Privacy Shield die Tool-Ergebnisse dieses Plugins? ' +
    '"Geschützt" (Default) interniert jedes rohe Tool-Ergebnis hinter dem ' +
    'Privacy Shield v4 — der LLM sieht nur einen identitätsfreien Digest. ' +
    '"Bypass" reicht rohe Ergebnisse unmaskiert durch (für vertrauenswürdige ' +
    'interne Quellen, deren Inhalte v4 strukturell nicht sinnvoll digestieren ' +
    'kann — z.B. Confluence-Seiten-Bodies). "Per-Tool" erlaubt eine ' +
    'Whitelist einzelner Tools (Advanced).';
  // Slice 2.5c — Plugin-author recommendation. Optional block on the
  // manifest (`privacy.recommendation: { mode, reason }`). When present
  // and the mode is valid, prepend it as a 📌 hint to the help text so
  // the operator sees the author's intent before choosing. NOT a
  // constraint — the operator is always free to override.
  const recommendation = readPrivacyRecommendation(entry);
  const help = recommendation
    ? `📌 Plugin-Autor empfiehlt: »${privacyModeLabel(recommendation.mode)}«` +
      (recommendation.reason ? ` — ${recommendation.reason}` : '') +
      `\n\n${baseHelp}`
    : baseHelp;
  return {
    key: PRIVACY_MODE_CONFIG_KEY,
    type: 'enum',
    label: 'Privacy Mode',
    required: false,
    default: PRIVACY_MODE_DEFAULT,
    help,
    enum: PRIVACY_MODE_VALUES.map((value) => ({
      value,
      label: privacyModeLabel(value),
    })),
  };
}

function readPrivacyRecommendation(
  entry: PluginCatalogEntry,
): { mode: (typeof PRIVACY_MODE_VALUES)[number]; reason: string } | undefined {
  const manifest = entry.manifest as Record<string, unknown> | undefined;
  if (!manifest) return undefined;
  const privacy = manifest['privacy'];
  if (!privacy || typeof privacy !== 'object') return undefined;
  const rec = (privacy as Record<string, unknown>)['recommendation'];
  if (!rec || typeof rec !== 'object') return undefined;
  const mode = (rec as Record<string, unknown>)['mode'];
  const reason = (rec as Record<string, unknown>)['reason'];
  if (typeof mode !== 'string') return undefined;
  if (!(PRIVACY_MODE_VALUES as readonly string[]).includes(mode)) {
    return undefined;
  }
  return {
    mode: mode as (typeof PRIVACY_MODE_VALUES)[number],
    reason: typeof reason === 'string' ? reason : '',
  };
}

function privacyBypassScopesField(): InstallSetupField {
  return {
    key: PRIVACY_BYPASS_SCOPES_CONFIG_KEY,
    type: 'string',
    label: 'Bypass-Tool-Whitelist (nur bei Privacy Mode = Per-Tool)',
    required: false,
    help:
      'Komma- oder Leerzeichen-getrennte Liste von Tool-Namen, die bei ' +
      'Privacy Mode "Per-Tool" unmaskiert durchgelassen werden. Beispiel: ' +
      '"confluence_get_page, confluence_get_page_by_title". Tools die hier ' +
      'NICHT stehen bleiben "guarded". Wird ignoriert wenn Privacy Mode auf ' +
      '"Geschützt" oder "Bypass" steht.',
  };
}

function privacyModeLabel(value: string): string {
  switch (value) {
    case 'guarded':
      return 'Geschützt (Default — Privacy Shield v4)';
    case 'bypass':
      return 'Bypass (Roh durchlassen — Operator übernimmt Verantwortung)';
    case 'per_tool':
      return 'Per-Tool (Advanced — Tool-Whitelist)';
    default:
      return value;
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

interface ValidationResult {
  values: Record<string, unknown>;
  errors: Array<{ key: string; code: string; message: string }>;
}

function validateValues(
  schema: InstallSetupSchema,
  incoming: Record<string, unknown>,
): ValidationResult {
  const values: Record<string, unknown> = {};
  const errors: Array<{ key: string; code: string; message: string }> = [];

  for (const field of schema.fields) {
    const raw = incoming[field.key];
    const missing =
      raw === undefined ||
      raw === null ||
      (typeof raw === 'string' && raw.length === 0);

    if (field.type === 'oauth') {
      errors.push({
        key: field.key,
        code: 'unsupported_type',
        message:
          'OAuth-Felder werden erst in Slice 1.2c unterstützt. ' +
          'Bitte nicht für v1.2a verwenden.',
      });
      continue;
    }

    if (missing) {
      if (field.required) {
        errors.push({
          key: field.key,
          code: 'required',
          message: `Feld "${field.label}" ist erforderlich.`,
        });
      } else if (field.default !== undefined) {
        values[field.key] = field.default;
      }
      continue;
    }

    const coerced = coerce(field, raw);
    if ('error' in coerced) {
      errors.push({
        key: field.key,
        code: coerced.error.code,
        message: coerced.error.message,
      });
      continue;
    }

    if (field.pattern && typeof coerced.value === 'string') {
      try {
        const re = new RegExp(field.pattern);
        if (!re.test(coerced.value)) {
          errors.push({
            key: field.key,
            code: 'pattern_mismatch',
            message: `"${field.label}" entspricht nicht dem erwarteten Muster.`,
          });
          continue;
        }
      } catch {
        // Ignore invalid regex in manifest; a separate manifest-lint step
        // will catch these later.
      }
    }

    values[field.key] = coerced.value;
  }

  return { values, errors };
}

type CoerceResult =
  | { value: unknown }
  | { error: { code: string; message: string } };

function coerce(field: InstallSetupField, raw: unknown): CoerceResult {
  switch (field.type) {
    case 'string':
    case 'secret':
      return typeof raw === 'string'
        ? { value: raw }
        : {
            error: {
              code: 'wrong_type',
              message: `"${field.label}" muss Text sein.`,
            },
          };
    case 'url': {
      if (typeof raw !== 'string') {
        return {
          error: {
            code: 'wrong_type',
            message: `"${field.label}" muss eine URL sein.`,
          },
        };
      }
      try {
        const url = new URL(raw);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
          throw new Error('non-http');
        }
      } catch {
        return {
          error: {
            code: 'invalid_url',
            message: `"${field.label}" ist keine gültige http(s)-URL.`,
          },
        };
      }
      return { value: raw };
    }
    case 'boolean':
      if (typeof raw === 'boolean') return { value: raw };
      if (raw === 'true') return { value: true };
      if (raw === 'false') return { value: false };
      return {
        error: {
          code: 'wrong_type',
          message: `"${field.label}" muss true oder false sein.`,
        },
      };
    case 'integer': {
      const n = typeof raw === 'number' ? raw : Number(raw);
      if (!Number.isInteger(n)) {
        return {
          error: {
            code: 'wrong_type',
            message: `"${field.label}" muss eine ganze Zahl sein.`,
          },
        };
      }
      return { value: n };
    }
    case 'enum': {
      if (typeof raw !== 'string') {
        return {
          error: {
            code: 'wrong_type',
            message: `"${field.label}" muss ein Text sein.`,
          },
        };
      }
      const allowed = (field.enum ?? []).map((o) => o.value);
      if (!allowed.includes(raw)) {
        return {
          error: {
            code: 'enum_mismatch',
            message: `"${field.label}" muss einer der erlaubten Werte sein: ${allowed.join(', ')}.`,
          },
        };
      }
      return { value: raw };
    }
    case 'host_list': {
      // #91 Option B — operator-curated list of bare hostnames. Unioned
      // into the plugin's effective ctx.http allowlist at runtime. Stored
      // as config (non-secret). Entries are normalised (trim + lowercase);
      // protocol prefixes and paths are rejected. A subdomain wildcard
      // (`*.example.com`) is permitted — the egress matcher supports it.
      if (raw === undefined || raw === null) return { value: [] };
      if (!Array.isArray(raw)) {
        return {
          error: {
            code: 'wrong_type',
            message: `"${field.label}" muss eine Liste von Hostnamen sein.`,
          },
        };
      }
      const hosts: string[] = [];
      for (const h of raw) {
        if (typeof h !== 'string') {
          return {
            error: {
              code: 'wrong_type',
              message: `"${field.label}" darf nur Text-Hostnamen enthalten.`,
            },
          };
        }
        const host = h.trim().toLowerCase();
        if (host.length === 0) continue;
        if (host.includes('://') || host.includes('/') || /\s/.test(host)) {
          return {
            error: {
              code: 'invalid_host',
              message: `"${host}" ist kein gültiger Hostname (kein Protokoll, kein Pfad).`,
            },
          };
        }
        hosts.push(host);
      }
      return { value: hosts };
    }
    case 'oauth':
      return {
        error: {
          code: 'unsupported_type',
          message: 'OAuth-Felder werden in Slice 1.2a nicht unterstützt.',
        },
      };
  }
}

// ---------------------------------------------------------------------------
// Secret vs config split
// ---------------------------------------------------------------------------

function splitSecretsAndConfig(
  schema: InstallSetupSchema,
  validated: Record<string, unknown>,
): { secrets: Record<string, string>; config: Record<string, unknown> } {
  const secrets: Record<string, string> = {};
  const config: Record<string, unknown> = {};
  for (const field of schema.fields) {
    const v = validated[field.key];
    if (v === undefined) continue;
    if (field.type === 'secret' || field.type === 'oauth') {
      if (typeof v === 'string') secrets[field.key] = v;
    } else {
      config[field.key] = v;
    }
  }
  return { secrets, config };
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

const SUPPORTED_TYPES = new Set<string>([
  'string',
  'url',
  'secret',
  'oauth',
  'enum',
  'boolean',
  'integer',
  'host_list',
]);

function isSupportedType(t: string): t is InstallSetupField['type'] {
  return SUPPORTED_TYPES.has(t);
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}
