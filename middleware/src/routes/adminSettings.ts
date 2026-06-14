import { Router } from 'express';
import type { Request, Response } from 'express';

import type { InstalledRegistry } from '../plugins/installedRegistry.js';
import type { SecretVault } from '../secrets/vault.js';
import {
  SETTINGS_CATEGORY_ORDER,
  buildSettingsCatalog,
  findSetting,
  settingPluginIds,
  type SettingDef,
} from '../platform/settingsCatalog.js';

/**
 * Operator settings overview — a single editable view of every `.env`-based
 * value that bootstrap writes into the runtime config-store / secret vault
 * (see `platform/settingsCatalog.ts`). Mounted at `/api/v1/admin/settings`.
 *
 *   GET  /            grouped catalog + current values (secrets: set/unset only)
 *   PATCH /           apply a batch of changes, then reactivate affected plugins
 *
 * Writes go through the same plumbing the post-install editor uses
 * (`installedRegistry.updateConfig` for config, `vault` for secrets), and each
 * touched plugin is `reactivate`d so the change takes effect live — no restart.
 */

interface AdminSettingsDeps {
  installedRegistry: InstalledRegistry;
  vault?: SecretVault;
  /** Tears down + re-activates a plugin so it re-reads fresh config/secrets. */
  reactivate?: (agentId: string) => Promise<void>;
  /** Plugin-contributed providers — adds a per-provider API-key setting so they
   *  can be connected on the overview (structural to avoid a hard dep). */
  llmProviderCatalog?: {
    list(): ReadonlyArray<{ readonly id: string; readonly label: string }>;
  };
}

interface ResolvedSetting {
  key: string;
  label: string;
  help?: string;
  category: string;
  type: SettingDef['type'];
  options?: SettingDef['options'];
  placeholder?: string;
  /** All target plugins installed? Drives editability in the UI. */
  installed: boolean;
  /** Current non-secret value (stringified), or null when unset. */
  value?: string | null;
  /** Secret only: whether a value is stored (never the value itself). */
  isSet?: boolean;
}

function stringifyConfigValue(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return null;
}

export function createAdminSettingsRouter(deps: AdminSettingsDeps): Router {
  const router = Router();

  // Static cross-plugin settings + per-provider API-key settings contributed by
  // plugin providers (e.g. MiniMax). Computed once per router; provider plugins
  // are registered at boot before routes are mounted.
  const catalog = buildSettingsCatalog(deps.llmProviderCatalog?.list() ?? []);

  const allInstalled = (def: SettingDef): boolean =>
    settingPluginIds(def).every((id) => deps.installedRegistry.has(id));

  // Resolve one setting's current state. Secret reads need a per-scope vault
  // lookup; the caller passes a cache so a GET doesn't re-list the same scope.
  const resolve = async (
    def: SettingDef,
    keyCache: Map<string, Set<string>>,
  ): Promise<ResolvedSetting> => {
    const base: ResolvedSetting = {
      key: def.key,
      label: def.label,
      ...(def.help ? { help: def.help } : {}),
      category: def.category,
      type: def.type,
      ...(def.options ? { options: def.options } : {}),
      ...(def.placeholder ? { placeholder: def.placeholder } : {}),
      installed: allInstalled(def),
    };
    if (def.secret) {
      const scope = def.secret.scopes[0];
      let isSet = false;
      if (deps.vault && scope) {
        let keys = keyCache.get(scope);
        if (!keys) {
          keys = new Set(await deps.vault.listKeys(scope));
          keyCache.set(scope, keys);
        }
        isSet = keys.has(def.secret.vaultKey);
      }
      return { ...base, isSet };
    }
    if (def.config) {
      const entry = deps.installedRegistry.get(def.config.pluginId);
      return {
        ...base,
        value: stringifyConfigValue(entry?.config?.[def.config.configKey]),
      };
    }
    return base;
  };

  // ── GET / — grouped catalog + current values ────────────────────────────
  router.get('/', async (_req: Request, res: Response) => {
    try {
      const keyCache = new Map<string, Set<string>>();
      const resolved = await Promise.all(
        catalog.map((def) => resolve(def, keyCache)),
      );
      const byCategory = new Map<string, ResolvedSetting[]>();
      for (const r of resolved) {
        const list = byCategory.get(r.category) ?? [];
        list.push(r);
        byCategory.set(r.category, list);
      }
      const categories = SETTINGS_CATEGORY_ORDER.filter((c) =>
        byCategory.has(c),
      ).map((category) => ({
        category,
        settings: byCategory.get(category) ?? [],
      }));
      res.json({ categories, vault_available: Boolean(deps.vault) });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ code: 'settings.read_failed', message });
    }
  });

  // ── PATCH / — apply a batch of changes ──────────────────────────────────
  router.patch('/', async (req: Request, res: Response) => {
    const body = req.body as { changes?: unknown } | null;
    const rawChanges = body?.changes;
    if (!Array.isArray(rawChanges) || rawChanges.length === 0) {
      res.status(400).json({
        code: 'settings.invalid_request',
        message: 'body must be { changes: [{ key, value }] }',
      });
      return;
    }

    const errors: Array<{ key: string; message: string }> = [];
    // Per-plugin config patches and per-scope secret patches, batched so each
    // plugin is written + reactivated at most once.
    const configPatch = new Map<string, Record<string, unknown>>();
    const secretSet = new Map<string, Record<string, string>>();
    const secretDelete = new Map<string, string[]>();
    const affected = new Set<string>();

    for (const raw of rawChanges) {
      if (typeof raw !== 'object' || raw === null) {
        errors.push({ key: '<unknown>', message: 'change must be an object' });
        continue;
      }
      const key = (raw as { key?: unknown }).key;
      const rawValue = (raw as { value?: unknown }).value;
      if (typeof key !== 'string') {
        errors.push({ key: '<unknown>', message: 'missing key' });
        continue;
      }
      const def = findSetting(key, catalog);
      if (!def) {
        errors.push({ key, message: 'unknown setting' });
        continue;
      }
      if (!allInstalled(def)) {
        errors.push({ key, message: 'target plugin not installed' });
        continue;
      }
      // null / empty → clear.
      const cleared =
        rawValue === null || rawValue === undefined || rawValue === '';
      const value = cleared ? '' : String(rawValue);

      // Type validation.
      if (!cleared) {
        if (def.type === 'number' && !Number.isFinite(Number(value))) {
          errors.push({ key, message: 'must be a number' });
          continue;
        }
        if (def.type === 'boolean' && value !== 'true' && value !== 'false') {
          errors.push({ key, message: "must be 'true' or 'false'" });
          continue;
        }
        if (
          def.type === 'enum' &&
          !(def.options ?? []).some((o) => o.value === value)
        ) {
          errors.push({ key, message: 'not an allowed option' });
          continue;
        }
        if (
          def.key === 'ANTHROPIC_API_KEY' &&
          !value.startsWith('sk-ant-')
        ) {
          errors.push({ key, message: 'Anthropic-Keys beginnen mit "sk-ant-"' });
          continue;
        }
        if (
          def.key === 'OPENAI_API_KEY' &&
          (!value.startsWith('sk-') || value.startsWith('sk-ant-'))
        ) {
          errors.push({
            key,
            message: 'OpenAI-Keys beginnen mit "sk-" (nicht "sk-ant-")',
          });
          continue;
        }
      }

      if (def.secret) {
        const legacyKey = def.secret.legacyVaultKey;
        for (const scope of def.secret.scopes) {
          if (cleared) {
            const list = secretDelete.get(scope) ?? [];
            list.push(def.secret.vaultKey);
            // Also delete the legacy fallback key, else readProviderApiKey keeps
            // resolving the stale key and the operator's revoke is ineffective.
            if (legacyKey !== undefined) list.push(legacyKey);
            secretDelete.set(scope, list);
          } else {
            const map = secretSet.get(scope) ?? {};
            map[def.secret.vaultKey] = value;
            secretSet.set(scope, map);
            // Drop the now-redundant legacy key so it can't diverge from the
            // canonical value the operator just set (writes run before deletes).
            if (legacyKey !== undefined) {
              const dl = secretDelete.get(scope) ?? [];
              dl.push(legacyKey);
              secretDelete.set(scope, dl);
            }
          }
          affected.add(scope);
        }
      } else if (def.config) {
        const patch = configPatch.get(def.config.pluginId) ?? {};
        // `null` marks a clear; applied against the live config below.
        patch[def.config.configKey] = cleared ? null : value;
        configPatch.set(def.config.pluginId, patch);
        affected.add(def.config.pluginId);
      }
    }

    if (affected.size === 0) {
      res.status(400).json({ code: 'settings.no_valid_changes', errors });
      return;
    }
    if (!deps.vault && (secretSet.size > 0 || secretDelete.size > 0)) {
      res.status(503).json({
        code: 'settings.vault_unavailable',
        message: 'vault not wired — secrets cannot be edited',
      });
      return;
    }

    try {
      // Config: read live config, shallow-merge the patch (null clears a key).
      for (const [pluginId, patch] of configPatch) {
        const installed = deps.installedRegistry.get(pluginId);
        if (!installed) continue;
        const next: Record<string, unknown> = { ...installed.config };
        for (const [k, v] of Object.entries(patch)) {
          if (v === null) delete next[k];
          else next[k] = v;
        }
        await deps.installedRegistry.updateConfig(pluginId, next);
      }
      // Secrets.
      if (deps.vault) {
        for (const [scope, map] of secretSet) {
          if (Object.keys(map).length > 0) await deps.vault.setMany(scope, map);
        }
        for (const [scope, keys] of secretDelete) {
          for (const k of keys) await deps.vault.deleteKey(scope, k);
        }
      }
      // Live apply: reactivate every touched plugin so it re-reads config.
      if (deps.reactivate) {
        for (const pluginId of affected) {
          await deps.reactivate(pluginId);
        }
      }

      // Echo back the post-change state of the touched settings.
      const keyCache = new Map<string, Set<string>>();
      const touchedKeys = new Set(
        rawChanges
          .map((c) =>
            typeof c === 'object' && c !== null
              ? (c as { key?: unknown }).key
              : undefined,
          )
          .filter((k): k is string => typeof k === 'string'),
      );
      const updated = await Promise.all(
        catalog.filter((d) => touchedKeys.has(d.key)).map((d) =>
          resolve(d, keyCache),
        ),
      );
      res.json({ updated, errors });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ code: 'settings.write_failed', message, errors });
    }
  });

  return router;
}
