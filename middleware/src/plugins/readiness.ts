/**
 * OM-16 — kernel-derived plugin readiness.
 *
 * WHY THIS EXISTS
 * ---------------
 * Two independent state axes already track "how is this plugin doing", and
 * neither one answers the operator's actual question:
 *
 *   A. `Plugin.install_state` ('available' | 'installed' | 'update-available' |
 *      'incompatible') reaches the UI, but is a pure registry-membership test:
 *      `routes/store.ts#applyInstallState` flips it to 'installed' the moment
 *      `installedRegistry.has(id)` is true. Emptying every credential does not
 *      move it.
 *
 *   B. `InstalledAgent.status` ('active' | 'inactive' | 'errored') knows more,
 *      but never leaves the server — it is not part of the `Plugin` DTO, and
 *      it only flips to 'errored' after the activation circuit breaker trips.
 *
 * So a Google-Workspace plugin whose entire credential set was deleted still
 * renders as "Installiert · AKTIV" while being unable to serve one request.
 *
 * Readiness is the missing derived third view: it checks the plugin's declared
 * REQUIRED setup fields against the vault (secrets) and the registry config
 * (everything else). It is computed by the kernel, so unlike the push-only
 * `PluginActionStatus` it also covers the majority of plugins that never call
 * `ctx.status.report()`.
 *
 * DESIGN RULES
 *   - Orthogonal, never a widening of `PluginInstallState` (20+ call sites
 *     branch on `install_state === 'installed'`).
 *   - Never throws and never 500s a store response. A broken/locked vault
 *     degrades to 'ready' — reporting every plugin as misconfigured because
 *     the vault hiccupped would be strictly worse than saying nothing.
 */

import type {
  Plugin,
  PluginReadiness,
  PluginSetupField,
} from '../api/admin-v1.js';
import type { ProviderVerification } from '../platform/providerCredentialVerifier.js';
import type { InstalledAgent, InstalledRegistry } from './installedRegistry.js';

export type { PluginReadiness } from '../api/admin-v1.js';

/** The subset of `SecretVault` readiness needs. Keeping it structural means
 *  tests can pass a two-line stub and the real vault fits without a cast. */
export interface ReadinessVault {
  listKeys(agentId: string): Promise<string[]>;
}

/** #884 — "does the LLM provider this plugin routes through actually have a
 *  working credential?". Structural for the same reason `ReadinessVault` is:
 *  a test passes a one-line stub and the real resolver fits without a cast.
 *  Returns `undefined` for a plugin that consumes no LLM at all. */
export interface ReadinessLlmProbe {
  resolve(
    pluginId: string,
    config: Record<string, unknown> | undefined,
  ): Promise<ProviderVerification | undefined>;
}

/** Kernel-injected synthetic setup fields (`_privacy_mode`,
 *  `_privacy_bypass_scopes`, …) are never operator-required — they always have
 *  a kernel default. They are not part of the plugin's manifest contract, so
 *  they must never make a plugin look unconfigured. */
const SYNTHETIC_FIELD_PREFIX = '_privacy_';

/** Field types the operator cannot satisfy by typing a value into the setup
 *  form. `oauth` fields are completed by the kernel broker flow and store their
 *  tokens under broker-owned keys, so a "missing" check against the manifest
 *  key would report a false positive on every OAuth plugin. */
function isCheckableField(field: PluginSetupField): boolean {
  if (field.key.startsWith(SYNTHETIC_FIELD_PREFIX)) return false;
  if (field.type === 'oauth') return false;
  // Required-by-default mirrors manifestLoader / installService.
  return field.required !== false;
}

/** A config value counts as supplied when it is present and non-empty. An
 *  empty string is exactly what the unvalidated
 *  `PATCH /runtime/installed/:id/secrets` write path leaves behind, so it must
 *  read as missing — that is the OM-16 reproduction. */
function hasConfigValue(
  config: Record<string, unknown> | undefined,
  key: string,
): boolean {
  const value = config?.[key];
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

/** Best-known moment this plugin was last observed working. Prefers the
 *  explicit activation timestamp; falls back to `installed_at` on registry
 *  entries written before that field existed (old JSON on disk). */
function verifiedAt(entry: InstalledAgent): string | null {
  return entry.last_activated_at ?? entry.installed_at ?? null;
}

/**
 * Derive readiness for a single plugin.
 *
 * Resolution order (first match wins):
 *   1. not in the installed registry              → 'not_installed'
 *   2. registry entry status === 'errored'        → 'errored' (+ error detail)
 *   3. a required, checkable setup field is empty → 'config_required'
 *   4. the plugin's assigned LLM provider has no
 *      VERIFIED credential                        → 'awaiting_llm'
 *   5. otherwise                                  → 'ready'
 *
 * Never rejects: a vault failure degrades to 'ready'.
 */
export async function computeReadiness(
  plugin: Pick<Plugin, 'id' | 'setup_fields'>,
  registry: InstalledRegistry,
  vault?: ReadinessVault,
  llmProbe?: ReadinessLlmProbe,
): Promise<PluginReadiness> {
  const entry = registry.get(plugin.id);
  if (!entry) {
    return { state: 'not_installed', missing_fields: [], verified_at: null };
  }

  if (entry.status === 'errored') {
    const detail = entry.last_activation_error;
    return {
      state: 'errored',
      missing_fields: [],
      verified_at: null,
      ...(detail ? { error_detail: detail } : {}),
    };
  }

  const checkable = (plugin.setup_fields ?? []).filter(isCheckableField);
  const needsVault = checkable.some((f) => f.type === 'secret');

  // A vault that is unavailable, locked, or throwing must not turn the whole
  // catalog into "configuration required" — that would be a worse lie than the
  // one this feature fixes. Degrade to "assume the secrets are there".
  let vaultKeys: Set<string> | null = null;
  if (needsVault && vault) {
    try {
      vaultKeys = new Set(await vault.listKeys(plugin.id));
    } catch {
      vaultKeys = null;
    }
  }

  const missing: string[] = [];
  for (const field of checkable) {
    if (field.type === 'secret') {
      // No vault wired (or it failed) → cannot disprove the secret exists.
      if (vaultKeys === null) continue;
      if (!vaultKeys.has(field.key)) missing.push(field.key);
      continue;
    }
    if (!hasConfigValue(entry.config, field.key)) missing.push(field.key);
  }

  if (missing.length > 0) {
    return { state: 'config_required', missing_fields: missing, verified_at: null };
  }

  if (!llmProbe) {
    return { state: 'ready', missing_fields: [], verified_at: verifiedAt(entry) };
  }

  try {
    const verdict = await llmProbe.resolve(plugin.id, entry.config);
    if (verdict !== undefined && verdict.status !== 'verified') {
      return { state: 'awaiting_llm', missing_fields: [], verified_at: null };
    }
  } catch {
    // Same rule as the vault: a provider-probe hiccup must not flip the whole
    // catalog away from "ready" based on an infrastructure-side failure.
  }

  return { state: 'ready', missing_fields: [], verified_at: verifiedAt(entry) };
}

/** Overlay readiness onto a plugin record. Returns a copy; catalog `Plugin`
 *  objects are shared across requests and must never be mutated. Any failure
 *  degrades to the untouched input — readiness is decoration, not payload. */
export async function withReadiness(
  plugin: Plugin,
  registry: InstalledRegistry,
  vault?: ReadinessVault,
  llmProbe?: ReadinessLlmProbe,
): Promise<Plugin> {
  try {
    const readiness = await computeReadiness(plugin, registry, vault, llmProbe);
    return { ...plugin, readiness };
  } catch {
    return plugin;
  }
}
