import { Router } from 'express';
import type { Request, Response } from 'express';

import type { BackgroundJobRegistry } from '../platform/backgroundJobRegistry.js';
import type { ChatAgentWrapIntrospection } from '../platform/chatAgentWrapRegistry.js';
import type { PromptContributionRegistry } from '../platform/promptContributionRegistry.js';
import type { ServiceRegistry } from '../platform/serviceRegistry.js';
import type { TurnHookRegistry } from '../platform/turnHookRegistry.js';
import { isAuditMode } from '../platform/httpAccessor.js';
import type { SetupOption } from '../api/admin-v1.js';
import {
  SetupOptionsResolveError,
  withTimeout,
} from '../plugins/dynamicAgentRuntime.js';
import { extractSetupSchema } from '../plugins/installService.js';
import type { InstalledRegistry } from '../plugins/installedRegistry.js';
import type { PluginCatalog } from '../plugins/manifestLoader.js';
import type { SecretVault } from '../secrets/vault.js';

/** Per-call budget for invoking a plugin's dynamic options provider. */
const SETUP_OPTIONS_TIMEOUT_MS = 8_000;
/** Hard cap on options returned to the editor. */
const MAX_SETUP_OPTIONS = 500;

/**
 * Runtime introspection endpoints — diagnostic view into what the harness
 * is running right now. Separate from the Store API because the Store
 * contract is shared with the admin UI and has strict typing; the runtime
 * view is operator-only and can evolve freely.
 *
 * Endpoints mounted under /api/v1/admin/runtime:
 *   GET /installed  — per-agent health (status, activation failures, last
 *                     error). Merges the installed-registry with
 *                     circuit-breaker fields added in M2.
 *   GET /registries — registry counts (services, turn hooks, background
 *                     jobs, chat-agent wrappers, prompt contributions).
 *                     One-shot snapshot of the Phase-0c plumbing state.
 */

interface RuntimeDeps {
  installedRegistry: InstalledRegistry;
  serviceRegistry: ServiceRegistry;
  turnHookRegistry: TurnHookRegistry;
  backgroundJobRegistry: BackgroundJobRegistry;
  // Type-erased read-only view — keeps the route/service layer seam clean.
  chatAgentWrapRegistry: ChatAgentWrapIntrospection;
  promptContributionRegistry: PromptContributionRegistry;
  /** Theme D: post-install credential edits route through the same vault
   *  the install-commit step seeds. Optional so existing test wiring
   *  without secret editing keeps compiling. */
  vault?: SecretVault;
  /** Required by the secret-editor PATCH path to look up which keys are
   *  `secret`/`oauth` (→ vault) vs everything else (→ registry config),
   *  mirroring the install-time `splitSecretsAndConfig`. Optional so
   *  existing test wiring without a catalog keeps compiling — the PATCH
   *  handler falls back to vault-only behaviour when absent. */
  catalog?: PluginCatalog;
  /** Called after a successful config or secret edit. Tears down the
   *  current runtime instance and re-activates it so the plugin reads
   *  the fresh values — most plugins cache config at activate-time. */
  reactivate?: (agentId: string) => Promise<void>;
  /** Live-plugin tool invoker for dynamic setup-field options (post-install).
   *  Optional so existing test wiring keeps compiling — the setup-options
   *  endpoint 503s when absent, and PATCH /config falls back to opaque-id
   *  validation for multiselect fields. */
  dynamicAgentRuntime?: {
    resolveSetupOptions(
      agentId: string,
      toolId: string,
      input: unknown,
    ): Promise<unknown>;
  };
}

export function createRuntimeRouter(deps: RuntimeDeps): Router {
  const router = Router();

  router.get('/installed', (_req: Request, res: Response) => {
    const rows = deps.installedRegistry.list().map((entry) => ({
      id: entry.id,
      installed_version: entry.installed_version,
      installed_at: entry.installed_at,
      status: entry.status,
      activation_failure_count: entry.activation_failure_count ?? 0,
      last_activation_error: entry.last_activation_error ?? null,
      last_activation_error_at: entry.last_activation_error_at ?? null,
    }));
    res.json({ items: rows, total: rows.length });
  });

  // GET /installed/:id — full entry for ONE installed plugin including
  // its non-secret `config`. Slice 2.5 — used by the Operator-UI's
  // Privacy-Mode quick-picker to read the current `_privacy_mode` value
  // so the dropdown can initialise with the stored selection.
  router.get('/installed/:id', (req: Request, res: Response) => {
    const rawId = req.params['id'];
    const id = typeof rawId === 'string' ? rawId : undefined;
    if (!id) {
      res
        .status(400)
        .json({ code: 'runtime.invalid_id', message: 'missing id' });
      return;
    }
    const entry = deps.installedRegistry.get(id);
    if (!entry) {
      res.status(404).json({
        code: 'runtime.not_installed',
        message: `agent '${id}' is not installed`,
      });
      return;
    }
    res.json({
      id: entry.id,
      installed_version: entry.installed_version,
      installed_at: entry.installed_at,
      status: entry.status,
      config: entry.config,
      activation_failure_count: entry.activation_failure_count ?? 0,
      last_activation_error: entry.last_activation_error ?? null,
      last_activation_error_at: entry.last_activation_error_at ?? null,
    });
  });

  // PATCH /installed/:id/config — merges into non-secret config values.
  // Caller supplies a PARTIAL config patch as request body; the patch is
  // shallow-merged into the existing config (only the keys present in the
  // body are touched). To explicitly clear a key, send it with `null`.
  // Secrets stay in the vault and are not touched here. Some plugins cache
  // config at activate-time; a restart/re-activate may be needed for those
  // to see the change. The response echoes the updated entry so the UI can
  // refresh inline.
  //
  // Slice 2.5 — Used by the Operator-UI's Privacy-Mode quick-picker on
  // an installed plugin to send `{ _privacy_mode: 'bypass' }` without
  // having to round-trip the entire setup_schema.
  router.patch(
    '/installed/:id/config',
    async (req: Request, res: Response) => {
      const rawId = req.params['id'];
      const id = typeof rawId === 'string' ? rawId : undefined;
      if (!id) {
        res
          .status(400)
          .json({ code: 'runtime.invalid_id', message: 'missing id' });
        return;
      }
      const body: unknown = req.body;
      if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        res.status(400).json({
          code: 'runtime.invalid_config',
          message: 'body must be a JSON object',
        });
        return;
      }
      const installed = deps.installedRegistry.get(id);
      if (!installed) {
        res.status(404).json({
          code: 'runtime.not_installed',
          message: `agent '${id}' is not installed`,
        });
        return;
      }
      // Shallow merge: existing config + body patch. `null` values clear
      // the key, anything else overwrites or adds.
      const patch = body as Record<string, unknown>;
      const nextConfig: Record<string, unknown> = { ...installed.config };
      for (const [k, v] of Object.entries(patch)) {
        if (v === null) {
          delete nextConfig[k];
          continue;
        }
        // Fields declaring `options_provider` carry a multiselect array; they
        // are validated against the live provider and stored JSON-encoded.
        // Every other key keeps the legacy blind-merge behaviour.
        const optField = findOptionsProviderField(deps.catalog, id, k);
        if (optField) {
          const checked = await validateMultiselectValue(
            v,
            id,
            optField,
            deps.dynamicAgentRuntime,
          );
          if ('error' in checked) {
            res.status(400).json(checked.error);
            return;
          }
          nextConfig[k] = checked.value;
          continue;
        }
        nextConfig[k] = v;
      }
      try {
        await deps.installedRegistry.updateConfig(id, nextConfig);
        if (deps.reactivate) {
          await deps.reactivate(id);
        }
        const updated = deps.installedRegistry.get(id);
        res.json({
          updated: updated
            ? {
                id: updated.id,
                config: updated.config,
                status: updated.status,
              }
            : null,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        res
          .status(500)
          .json({ code: 'runtime.update_failed', message });
      }
    },
  );

  // GET /installed/:id/setup-options/:fieldKey — dynamic, post-install options
  // for a field that declares `options_provider`. Resolves the named toolkit
  // tool on the ACTIVE plugin and returns the choices for the editor. Advisory
  // for the UI only; PATCH /config re-validates server-side (trust boundary).
  // Concurrent identical requests share one provider invocation.
  const optionsInFlight = new Map<string, Promise<SetupOption[] | null>>();
  router.get(
    '/installed/:id/setup-options/:fieldKey',
    async (req: Request, res: Response) => {
      const id = readId(req);
      const rawField = req.params['fieldKey'];
      const fieldKey = typeof rawField === 'string' ? rawField : '';
      if (!id || !fieldKey) {
        res.status(400).json({
          code: 'runtime.invalid_id',
          message: 'missing id or fieldKey',
        });
        return;
      }
      if (!deps.installedRegistry.get(id)) {
        res.status(404).json({
          code: 'runtime.not_installed',
          message: `agent '${id}' is not installed`,
        });
        return;
      }
      const field = findOptionsProviderField(deps.catalog, id, fieldKey);
      if (!field) {
        res.status(400).json({
          code: 'runtime.no_options_provider',
          message: `field '${fieldKey}' declares no options_provider`,
        });
        return;
      }
      const resolver = deps.dynamicAgentRuntime;
      if (!resolver) {
        res.status(503).json({
          code: 'runtime.options_unavailable',
          message: 'dynamic setup-options are not available on this core',
        });
        return;
      }
      const cacheKey = `${id}::${fieldKey}`;
      try {
        let pending = optionsInFlight.get(cacheKey);
        if (!pending) {
          pending = withTimeout(
            resolver.resolveSetupOptions(id, field.toolId, {}),
            SETUP_OPTIONS_TIMEOUT_MS,
            'setup-options provider timed out',
          ).then((raw) => normalizeSetupOptions(raw));
          optionsInFlight.set(cacheKey, pending);
          void pending
            .catch(() => undefined)
            .finally(() => optionsInFlight.delete(cacheKey));
        }
        const options = await pending;
        if (options === null) {
          res.status(502).json({
            code: 'runtime.options_provider_bad_shape',
            message: 'provider did not return an options array',
          });
          return;
        }
        res.json({ options });
      } catch (err) {
        sendOptionsError(res, err);
      }
    },
  );

  // PATCH /installed/:id/audit-mode — #91 operator mode switch for an
  // audit/scanner plugin. Body: { mode: 'single-host'|'allowlist'|'public-web' }.
  // Rejected unless the manifest declares permissions.network.web_scanner.
  // Merges `audit_mode` into the registry config (other keys untouched) and
  // re-activates so the egress filter picks up the new mode.
  router.patch(
    '/installed/:id/audit-mode',
    async (req: Request, res: Response) => {
      const rawId = req.params['id'];
      const id = typeof rawId === 'string' ? rawId : undefined;
      if (!id) {
        res
          .status(400)
          .json({ code: 'runtime.invalid_id', message: 'missing id' });
        return;
      }
      const body = req.body as { mode?: unknown } | null;
      const mode = body?.mode;
      if (!isAuditMode(mode)) {
        res.status(400).json({
          code: 'runtime.invalid_audit_mode',
          message:
            "mode must be one of 'single-host', 'allowlist', 'public-web'",
        });
        return;
      }
      const installed = deps.installedRegistry.get(id);
      if (!installed) {
        res.status(404).json({
          code: 'runtime.not_installed',
          message: `agent '${id}' is not installed`,
        });
        return;
      }
      const isWebScanner =
        deps.catalog?.get(id)?.plugin.permissions_summary
          ?.network_web_scanner === true;
      if (!isWebScanner) {
        res.status(400).json({
          code: 'runtime.not_web_scanner',
          message:
            `agent '${id}' does not declare permissions.network.web_scanner — ` +
            'audit_mode applies only to audit/scanner plugins',
        });
        return;
      }
      try {
        await deps.installedRegistry.updateConfig(id, {
          ...installed.config,
          audit_mode: mode,
        });
        if (deps.reactivate) {
          await deps.reactivate(id);
        }
        res.json({ id, audit_mode: mode });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        res.status(500).json({ code: 'runtime.update_failed', message });
      }
    },
  );

  // ── GET /installed/:id/secrets ─────────────────────────────────────
  // Vault key NAMES only — values are never returned. The non-secret
  // setup values stored in `registry.config` are returned in full as
  // `config_values`, because they're not sensitive (enum choices, URLs,
  // public flags) and the post-install editor needs them to render the
  // current selection in dropdowns / text fields.
  //
  // `keys`          — secret-typed key names (→ vault). Names only.
  // `config_keys`   — non-secret setup-field names stored in
  //                   registry.config. Sorted; redundant with
  //                   `config_values` keys but kept for backwards-compat
  //                   with older clients.
  // `config_values` — actual stored non-secret values, stringified.
  //                   Mirrors the install-time split: `field.type ===
  //                   'secret' | 'oauth'` → vault (no value here),
  //                   everything else → registry.config (value here).
  router.get(
    '/installed/:id/secrets',
    async (req: Request, res: Response) => {
      const id = readId(req);
      if (!id) {
        res
          .status(400)
          .json({ code: 'runtime.invalid_id', message: 'missing id' });
        return;
      }
      const installed = deps.installedRegistry.get(id);
      if (!installed) {
        res.status(404).json({
          code: 'runtime.not_installed',
          message: `agent '${id}' is not installed`,
        });
        return;
      }
      if (!deps.vault) {
        res.status(503).json({
          code: 'runtime.vault_unavailable',
          message: 'vault not wired into runtime route',
        });
        return;
      }
      try {
        const keys = await deps.vault.listKeys(id);
        const configValues = stringifyConfigValues(installed.config);
        const configKeys = Object.keys(configValues);
        res.json({
          keys: keys.sort(),
          config_keys: configKeys.sort(),
          config_values: configValues,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        res.status(500).json({ code: 'runtime.vault_read_failed', message });
      }
    },
  );

  // ── PATCH /installed/:id/secrets ───────────────────────────────────
  // Theme D: post-install credential edits. Some plugins emit secrets
  // only after the first authenticated call (refresh-tokens, webhook
  // secrets returned by the provider after registration), so the
  // install-commit form is the wrong moment to capture them. This
  // endpoint mirrors `installService.deps.vault.setMany` and lets the
  // operator upsert / delete keys after install.
  //
  // Routing rule (mirrors install-time `splitSecretsAndConfig`):
  //   field.type === 'secret' | 'oauth'  →  vault
  //   anything else (string/url/enum/…)   →  registry.config
  // Falls back to vault-only when no catalog entry / setup-schema is
  // available (legacy plugins without a manifest).
  //
  // Body shape: { set?: Record<string, string>, delete?: string[] }
  // Response  : { keys: string[], config_keys: string[] }  (sorted, post-update)
  //
  // Owner-scope: vault namespaces are per-pluginId, not per-user. The
  // platform's auth layer gates the admin route mount; this handler
  // does NOT add a second per-user check because installed agents are
  // a global resource in the current architecture. Adding per-user
  // ACL would require a wider auth-model change (see roadmap).
  router.patch(
    '/installed/:id/secrets',
    async (req: Request, res: Response) => {
      const id = readId(req);
      if (!id) {
        res
          .status(400)
          .json({ code: 'runtime.invalid_id', message: 'missing id' });
        return;
      }
      const installed = deps.installedRegistry.get(id);
      if (!installed) {
        res.status(404).json({
          code: 'runtime.not_installed',
          message: `agent '${id}' is not installed`,
        });
        return;
      }
      if (!deps.vault) {
        res.status(503).json({
          code: 'runtime.vault_unavailable',
          message: 'vault not wired into runtime route',
        });
        return;
      }

      const body: unknown = req.body;
      if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        res.status(400).json({
          code: 'runtime.invalid_secrets_body',
          message: 'body must be a JSON object with `set` and/or `delete`',
        });
        return;
      }
      const setEntries = parseSetEntries(
        (body as { set?: unknown }).set,
      );
      const deleteKeys = parseDeleteKeys(
        (body as { delete?: unknown }).delete,
      );
      if (setEntries === 'invalid' || deleteKeys === 'invalid') {
        res.status(400).json({
          code: 'runtime.invalid_secrets_body',
          message:
            '`set` must be Record<string,string>; `delete` must be string[]',
        });
        return;
      }
      if (
        Object.keys(setEntries).length === 0 &&
        deleteKeys.length === 0
      ) {
        res.status(400).json({
          code: 'runtime.empty_secrets_patch',
          message: 'patch must include at least one `set` or `delete` entry',
        });
        return;
      }

      const secretFieldKeys = resolveSecretFieldKeys(deps.catalog, id);
      const isSecret = (key: string): boolean =>
        secretFieldKeys === null ? true : secretFieldKeys.has(key);

      const vaultSet: Record<string, string> = {};
      const vaultDelete: string[] = [];
      const configSet: Record<string, unknown> = {};
      const configDelete: string[] = [];
      for (const [k, v] of Object.entries(setEntries)) {
        if (isSecret(k)) vaultSet[k] = v;
        else configSet[k] = v;
      }
      for (const k of deleteKeys) {
        if (isSecret(k)) vaultDelete.push(k);
        else configDelete.push(k);
      }

      try {
        if (Object.keys(vaultSet).length > 0) {
          await deps.vault.setMany(id, vaultSet);
        }
        for (const key of vaultDelete) {
          await deps.vault.deleteKey(id, key);
        }
        if (
          Object.keys(configSet).length > 0 ||
          configDelete.length > 0
        ) {
          const nextConfig: Record<string, unknown> = {
            ...installed.config,
            ...configSet,
          };
          for (const k of configDelete) delete nextConfig[k];
          await deps.installedRegistry.updateConfig(id, nextConfig);
        }
        if (deps.reactivate) {
          await deps.reactivate(id);
        }
        const keys = await deps.vault.listKeys(id);
        const updated = deps.installedRegistry.get(id);
        const configValues = stringifyConfigValues(updated?.config);
        const configKeys = Object.keys(configValues);
        res.json({
          keys: keys.sort(),
          config_keys: configKeys.sort(),
          config_values: configValues,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        res.status(500).json({ code: 'runtime.vault_write_failed', message });
      }
    },
  );

  router.get('/registries', (_req: Request, res: Response) => {
    res.json({
      services: {
        providers: deps.serviceRegistry.names(),
        count: deps.serviceRegistry.names().length,
      },
      turn_hooks: deps.turnHookRegistry.counts(),
      background_jobs: {
        names: deps.backgroundJobRegistry.names(),
        count: deps.backgroundJobRegistry.names().length,
      },
      chat_agent_wrappers: {
        labels: deps.chatAgentWrapRegistry.labels(),
        count: deps.chatAgentWrapRegistry.count(),
      },
      prompt_contributions: {
        labels: deps.promptContributionRegistry.labels(),
        count: deps.promptContributionRegistry.count(),
      },
    });
  });

  return router;
}

function readId(req: Request): string | null {
  const raw = req.params['id'];
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

/**
 * Stringifies the non-secret values stored in `installed.config` so the
 * post-install editor can render the current selection. Drops keys with
 * `undefined` / `null` and skips values that don't have a sensible
 * scalar representation (objects, arrays). `boolean` and `integer`
 * SetupField types coerce to their string form (`"true"`, `"42"`).
 */
function stringifyConfigValues(
  config: Record<string, unknown> | undefined,
): Record<string, string> {
  if (!config) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(config)) {
    if (v === undefined || v === null) continue;
    if (typeof v === 'string') out[k] = v;
    else if (typeof v === 'number' || typeof v === 'boolean') out[k] = String(v);
    // Skip object/array values — no sensible single-line rendering and
    // the post-install editor only handles scalar SetupField types.
  }
  return out;
}

function parseSetEntries(raw: unknown): Record<string, string> | 'invalid' {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) return 'invalid';
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof k !== 'string' || k.length === 0) return 'invalid';
    if (typeof v !== 'string') return 'invalid';
    out[k] = v;
  }
  return out;
}

function parseDeleteKeys(raw: unknown): string[] | 'invalid' {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return 'invalid';
  for (const k of raw) {
    if (typeof k !== 'string' || k.length === 0) return 'invalid';
  }
  return raw as string[];
}

/**
 * Returns the set of setup-field keys whose `type` is `secret` or `oauth` for
 * the given pluginId, or `null` when the catalog/manifest is unavailable. The
 * PATCH handler treats `null` as "route everything to the vault" — preserving
 * the legacy behaviour for plugins without a setup schema.
 */
function resolveSecretFieldKeys(
  catalog: PluginCatalog | undefined,
  pluginId: string,
): Set<string> | null {
  if (!catalog) return null;
  const entry = catalog.get(pluginId);
  if (!entry) return null;
  const schema = extractSetupSchema(entry);
  if (!schema) return null;
  const out = new Set<string>();
  for (const f of schema.fields) {
    if (f.type === 'secret' || f.type === 'oauth') out.add(f.key);
  }
  return out;
}

interface OptionsProviderField {
  toolId: string;
  multi: boolean;
}

/**
 * Reads a setup field's `options_provider` / `multi` straight from the raw
 * manifest (mirrors `extractSetupSchema`'s raw read, so it stays decoupled from
 * the InstallSetupField type). Returns null when the field does not declare a
 * dynamic options provider — the caller then treats the key as an ordinary
 * config value, preserving legacy behaviour.
 */
function findOptionsProviderField(
  catalog: PluginCatalog | undefined,
  pluginId: string,
  fieldKey: string,
): OptionsProviderField | null {
  if (!catalog) return null;
  const entry = catalog.get(pluginId);
  if (!entry) return null;
  const manifest = entry.manifest;
  if (!manifest || typeof manifest !== 'object') return null;
  const setup = (manifest as Record<string, unknown>)['setup'];
  if (!setup || typeof setup !== 'object') return null;
  const fieldsRaw = (setup as Record<string, unknown>)['fields'];
  if (!Array.isArray(fieldsRaw)) return null;
  for (const raw of fieldsRaw) {
    if (!raw || typeof raw !== 'object') continue;
    const f = raw as Record<string, unknown>;
    if (f['key'] !== fieldKey) continue;
    const toolId =
      typeof f['options_provider'] === 'string' ? f['options_provider'] : '';
    if (!toolId) return null;
    return { toolId, multi: f['multi'] === true };
  }
  return null;
}

/**
 * Coerce a provider's raw return into well-formed SetupOption rows. Returns
 * null when the shape is wrong (not an array) so the caller can 502; an empty
 * array is legitimate (e.g. nothing shared yet) and passes through. Caps the
 * list and keeps only `{value,label}` string rows (rendered as text only).
 */
function normalizeSetupOptions(raw: unknown): SetupOption[] | null {
  if (!Array.isArray(raw)) return null;
  const out: SetupOption[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const value = typeof o['value'] === 'string' ? o['value'] : undefined;
    const label = typeof o['label'] === 'string' ? o['label'] : undefined;
    if (!value || !label) continue;
    const opt: SetupOption = { value, label };
    if (typeof o['group'] === 'string') opt.group = o['group'];
    out.push(opt);
    if (out.length >= MAX_SETUP_OPTIONS) break;
  }
  return out;
}

/** Map a provider-invocation failure to the typed HTTP response. */
function sendOptionsError(res: Response, err: unknown): void {
  if (err instanceof SetupOptionsResolveError) {
    res
      .status(409)
      .json({ code: 'runtime.agent_inactive', message: err.message });
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes('timed out')) {
    res
      .status(504)
      .json({ code: 'runtime.options_provider_timeout', message });
    return;
  }
  res
    .status(502)
    .json({ code: 'runtime.options_provider_failed', message });
}

/**
 * Server-side validation of a submitted multiselect value (do NOT trust the
 * client). Requires a `string[]`; re-invokes the provider and rejects any value
 * not in the live set. If the provider is inactive/throws/times out at save
 * time, degrades to accepting only syntactically-safe opaque ids rather than
 * bricking the save. Returns the value JSON-encoded for scalar config storage.
 */
async function validateMultiselectValue(
  raw: unknown,
  pluginId: string,
  field: OptionsProviderField,
  resolver: RuntimeDeps['dynamicAgentRuntime'],
): Promise<{ value: string } | { error: { code: string; message: string } }> {
  if (!Array.isArray(raw) || !raw.every((x) => typeof x === 'string')) {
    return {
      error: {
        code: 'runtime.invalid_multiselect',
        message: 'value must be an array of strings',
      },
    };
  }
  const values = raw as string[];

  let allowed: Set<string> | null = null;
  if (resolver) {
    try {
      const result = await withTimeout(
        resolver.resolveSetupOptions(pluginId, field.toolId, {}),
        SETUP_OPTIONS_TIMEOUT_MS,
        'setup-options provider timed out',
      );
      const opts = normalizeSetupOptions(result);
      if (opts) allowed = new Set(opts.map((o) => o.value));
    } catch {
      // provider down / inactive / threw → fall through to degraded check
    }
  }

  if (allowed) {
    const allowedSet = allowed;
    const bad = values.find((x) => !allowedSet.has(x));
    if (bad !== undefined) {
      return {
        error: {
          code: 'runtime.value_not_offered',
          message: `value '${bad}' is not an offered option`,
        },
      };
    }
  } else {
    const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
    const bad = values.find((x) => !SAFE_ID.test(x));
    if (bad !== undefined) {
      return {
        error: {
          code: 'runtime.invalid_multiselect',
          message: `value '${bad}' is not a safe opaque id`,
        },
      };
    }
  }
  return { value: JSON.stringify(values) };
}
