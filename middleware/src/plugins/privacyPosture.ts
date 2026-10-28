import {
  PRIVACY_BYPASS_SCOPES_CONFIG_KEY,
  PRIVACY_FORCE_GUARDED_ENV_VAR,
  PRIVACY_MODE_CONFIG_KEY,
  PRIVACY_MODE_VALUES,
  PRIVACY_REDACT_CAPABILITY,
  PRIVACY_REDACT_SERVICE_NAME,
  parseScopes,
} from '@omadia/plugin-api';

import type { InstalledRegistry } from './installedRegistry.js';
import type { PluginCatalog } from './manifestLoader.js';

/**
 * The instance's Privacy Shield posture, for admins (#1507, #1508).
 *
 * - `shield_active`  a `privacy.redact@1` provider is published right now.
 *                    The orchestrator resolves it late and runs every turn
 *                    UNMASKED when it is absent, so an uninstalled guard used
 *                    to switch the shield off without any surface saying so.
 * - `force_guarded`  `OMADIA_PRIVACY_FORCE_GUARDED` clamps every plugin to
 *                    `guarded` (`resolveEffectivePrivacyMode`). The per-plugin
 *                    picker reads it to show "Locked by org policy" instead of
 *                    offering a bypass that would have no effect.
 * - `provider_ids`   installed plugins whose manifest provides the capability.
 *                    Non-empty with `shield_active: false` means the guard is
 *                    installed but not running (failed activation), which the
 *                    banner words differently from "uninstalled".
 *
 * Authenticated only, like the master-key posture in `/admin/vault-status`:
 * the public `/health` does not tell a scanner that an instance runs without
 * its shield.
 */
export interface PrivacyPosture {
  readonly shield_active: boolean;
  readonly force_guarded: boolean;
  readonly provider_ids: readonly string[];
}

export function isForceGuarded(env: NodeJS.ProcessEnv): boolean {
  // Exactly the comparison `resolveEffectivePrivacyMode` makes, so the UI never
  // shows a lock the dispatch hook does not apply, or the reverse.
  return env[PRIVACY_FORCE_GUARDED_ENV_VAR] === 'true';
}

export function buildPrivacyPosture(input: {
  readonly serviceRegistry: { has(name: string): boolean };
  readonly installedRegistry: Pick<InstalledRegistry, 'list'>;
  readonly catalog?: Pick<PluginCatalog, 'get'>;
  readonly env: NodeJS.ProcessEnv;
}): PrivacyPosture {
  const providerIds = input.installedRegistry
    .list()
    .map((entry) => entry.id)
    .filter((id) =>
      (input.catalog?.get(id)?.plugin.provides ?? []).includes(
        PRIVACY_REDACT_CAPABILITY,
      ),
    );
  return {
    shield_active: input.serviceRegistry.has(PRIVACY_REDACT_SERVICE_NAME),
    force_guarded: isForceGuarded(input.env),
    provider_ids: providerIds,
  };
}

/** Is `key` one of the kernel-synthetic privacy config keys? */
export function isPrivacyConfigKey(key: string): boolean {
  return (
    key === PRIVACY_MODE_CONFIG_KEY || key === PRIVACY_BYPASS_SCOPES_CONFIG_KEY
  );
}

/** Just the privacy keys of a plugin config, for the audit trail. */
export function privacySettingsOf(
  config: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return {
    [PRIVACY_MODE_CONFIG_KEY]: config[PRIVACY_MODE_CONFIG_KEY] ?? null,
    [PRIVACY_BYPASS_SCOPES_CONFIG_KEY]:
      config[PRIVACY_BYPASS_SCOPES_CONFIG_KEY] ?? null,
  };
}

export type PrivacyConfigCheck =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly message: string };

/**
 * Validate and normalise a PATCH value for one of the two kernel-synthetic
 * privacy keys (`isPrivacyConfigKey`). Other keys pass through untouched.
 *
 * `_privacy_mode` must be one of the known modes: an unknown value used to be
 * stored and then silently read as `guarded`, so the picker showed a mode the
 * dispatch hook never applied. `_privacy_bypass_scopes` is stored as the
 * canonical `string[]` (#1510): the store editor sends a comma-separated
 * string, and `parseScopes` is the parser the dispatch hook itself uses.
 */
export function checkPrivacyConfigValue(
  key: string,
  value: unknown,
): PrivacyConfigCheck {
  if (key === PRIVACY_MODE_CONFIG_KEY) {
    return (PRIVACY_MODE_VALUES as readonly unknown[]).includes(value)
      ? { ok: true, value }
      : {
          ok: false,
          message: `${PRIVACY_MODE_CONFIG_KEY} must be one of ${PRIVACY_MODE_VALUES.join(', ')}`,
        };
  }
  if (key === PRIVACY_BYPASS_SCOPES_CONFIG_KEY) {
    const isStringList =
      typeof value === 'string' ||
      (Array.isArray(value) && value.every((v) => typeof v === 'string'));
    if (!isStringList) {
      return {
        ok: false,
        message: `${PRIVACY_BYPASS_SCOPES_CONFIG_KEY} must be a string or a list of tool names`,
      };
    }
    return { ok: true, value: [...parseScopes(value)] };
  }
  return { ok: true, value };
}
