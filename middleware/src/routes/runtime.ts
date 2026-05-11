import { Router } from 'express';
import type { Request, Response } from 'express';

import type { BackgroundJobRegistry } from '../platform/backgroundJobRegistry.js';
import type { ChatAgentWrapIntrospection } from '../platform/chatAgentWrapRegistry.js';
import type { PromptContributionRegistry } from '../platform/promptContributionRegistry.js';
import type { ServiceRegistry } from '../platform/serviceRegistry.js';
import type { TurnHookRegistry } from '../platform/turnHookRegistry.js';
import { extractSetupSchema } from '../plugins/installService.js';
import type { InstalledRegistry } from '../plugins/installedRegistry.js';
import type { PluginCatalog } from '../plugins/manifestLoader.js';
import type { SecretVault } from '../secrets/vault.js';

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

  // PATCH /installed/:id/config — replaces non-secret config values. Caller
  // supplies the FULL next config as request body. Secrets stay in the vault
  // and are not touched here. Some plugins cache config at activate-time; a
  // restart/re-activate may be needed for those to see the change. The
  // response echoes the updated entry so the UI can refresh inline.
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
      if (!deps.installedRegistry.has(id)) {
        res.status(404).json({
          code: 'runtime.not_installed',
          message: `agent '${id}' is not installed`,
        });
        return;
      }
      try {
        await deps.installedRegistry.updateConfig(
          id,
          body as Record<string, unknown>,
        );
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
