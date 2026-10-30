import {
  PRIVACY_BYPASS_SCOPES_CONFIG_KEY,
  PRIVACY_FORCE_GUARDED_ENV_VAR,
  PRIVACY_MODE_CONFIG_KEY,
  PRIVACY_MODE_VALUES,
  PRIVACY_REDACT_CAPABILITY,
  PRIVACY_REDACT_SERVICE_NAME,
  parseScopes,
  type PrivacyGuardService,
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
 * - `name_detector`  #1562 — the C1 name detector: unconfigured, active or
 *                    unreachable, where its URL comes from, and when it last
 *                    failed in a turn. `null` while no shield runs or the
 *                    provider cannot report it. Without C1, person names in
 *                    free text reach the model unmasked; before this the only
 *                    trace was a boot log line.
 *
 * Authenticated only, like the master-key posture in `/admin/vault-status`:
 * the public `/health` does not tell a scanner that an instance runs without
 * its shield.
 */
export interface PrivacyPosture {
  readonly shield_active: boolean;
  readonly force_guarded: boolean;
  readonly provider_ids: readonly string[];
  readonly name_detector?: NameDetectorPosture | null;
  /** #1556 follow-up — field-classification candidates an admin still has
   *  to look at: `fields_needing_clarification` counts `needs_clarification`
   *  AND `confirmed_conflict` (the latter also alone in
   *  `fields_confirmed_conflict`), `fields_suggested_open` the open
   *  suggestions. All 0 without Postgres. */
  readonly fields_needing_clarification?: number;
  readonly fields_suggested_open?: number;
  readonly fields_confirmed_conflict?: number;
}

export interface NameDetectorPosture {
  readonly state: 'unconfigured' | 'active' | 'unreachable';
  readonly source: 'setup' | 'env' | null;
  readonly last_failure_at: string | null;
  /** `mask_user_prompt`: only while it is on are names the user types masked. */
  readonly prompt_masking: boolean;
}

/**
 * #1562 — ask the running shield for its name detector's state (it probes
 * the sidecar with a short timeout). `null` when no shield runs, the provider
 * has no `nameDetectorStatus`, or the call fails.
 */
export async function readNameDetectorPosture(serviceRegistry: {
  get<T>(name: string): T | undefined;
}): Promise<NameDetectorPosture | null> {
  const service = serviceRegistry.get<PrivacyGuardService>(PRIVACY_REDACT_SERVICE_NAME);
  if (service?.nameDetectorStatus === undefined) return null;
  try {
    const status = await service.nameDetectorStatus();
    return {
      state: status.state,
      source: status.source,
      last_failure_at: status.lastFailureAt,
      prompt_masking: status.promptMasking,
    };
  } catch (err) {
    console.warn('[privacy-posture] nameDetectorStatus failed:', err);
    return null;
  }
}

export interface OpenFieldClassificationCounts {
  readonly needsClarification: number;
  readonly suggested: number;
  readonly confirmedConflict: number;
}

/**
 * #1556 follow-up — the open field-classification counts for the posture.
 * Informational only: zeros when no counter is wired (in-memory backend) and
 * on any failure (table not migrated yet), never an error for the banner.
 */
export async function readOpenFieldClassification(
  count: (() => Promise<OpenFieldClassificationCounts>) | undefined,
): Promise<{
  fields_needing_clarification: number;
  fields_suggested_open: number;
  fields_confirmed_conflict: number;
}> {
  const zero = {
    fields_needing_clarification: 0,
    fields_suggested_open: 0,
    fields_confirmed_conflict: 0,
  };
  if (count === undefined) return zero;
  try {
    const counts = await count();
    return {
      fields_needing_clarification: counts.needsClarification + counts.confirmedConflict,
      fields_suggested_open: counts.suggested,
      fields_confirmed_conflict: counts.confirmedConflict,
    };
  } catch (err) {
    console.warn(
      '[privacy-posture] field-classification count failed:',
      err instanceof Error ? err.message : err,
    );
    return zero;
  }
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
  const providerIds = privacyProviderIds(input.installedRegistry, input.catalog);
  return {
    shield_active: input.serviceRegistry.has(PRIVACY_REDACT_SERVICE_NAME),
    force_guarded: isForceGuarded(input.env),
    provider_ids: providerIds,
  };
}

/** Installed plugins whose manifest provides the Privacy Shield capability. */
export function privacyProviderIds(
  installedRegistry: Pick<InstalledRegistry, 'list'>,
  catalog: Pick<PluginCatalog, 'get'> | undefined,
): string[] {
  return installedRegistry
    .list()
    .map((entry) => entry.id)
    .filter((id) =>
      (catalog?.get(id)?.plugin.provides ?? []).includes(
        PRIVACY_REDACT_CAPABILITY,
      ),
    );
}

/**
 * #1507 — would uninstalling `pluginId` remove the last Privacy Shield
 * provider while the org policy `OMADIA_PRIVACY_FORCE_GUARDED` is on? The
 * orchestrator runs every turn unmasked without a provider, so the uninstall
 * would void the policy without any setting saying so. Removing one of two
 * providers stays allowed.
 */
export function uninstallVoidsForceGuarded(input: {
  readonly pluginId: string;
  readonly installedRegistry: Pick<InstalledRegistry, 'list'>;
  readonly catalog?: Pick<PluginCatalog, 'get'>;
  readonly env: NodeJS.ProcessEnv;
}): boolean {
  if (!isForceGuarded(input.env)) return false;
  // Only RUNNING providers keep the shield up: an errored or inactive second
  // provider must not make the active one look removable.
  const active = new Set(
    input.installedRegistry
      .list()
      .filter((entry) => entry.status === 'active')
      .map((entry) => entry.id),
  );
  const running = privacyProviderIds(input.installedRegistry, input.catalog).filter(
    (id) => active.has(id),
  );
  return running.includes(input.pluginId) && running.length === 1;
}

/** Is `key` one of the kernel-synthetic privacy config keys? */
export function isPrivacyConfigKey(key: string): boolean {
  return (
    key === PRIVACY_MODE_CONFIG_KEY || key === PRIVACY_BYPASS_SCOPES_CONFIG_KEY
  );
}

/** The privacy guard's list of fields that reach the model in clear (#1556). */
export const NON_PERSONAL_FIELDS_CONFIG_KEY = 'non_personal_fields';

/**
 * Just the privacy keys of a plugin config, for the audit trail. The privacy
 * guard's `non_personal_fields` is one of them (#1556 follow-up): a listed
 * field reaches the model in clear, so a manual edit through the PATCH route
 * is audited like a confirm on the field-classification page. It is included
 * only when set, so plugins without it keep their two-key audit shape.
 */
export function privacySettingsOf(
  config: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const nonPersonal = config[NON_PERSONAL_FIELDS_CONFIG_KEY];
  return {
    [PRIVACY_MODE_CONFIG_KEY]: config[PRIVACY_MODE_CONFIG_KEY] ?? null,
    [PRIVACY_BYPASS_SCOPES_CONFIG_KEY]:
      config[PRIVACY_BYPASS_SCOPES_CONFIG_KEY] ?? null,
    ...(nonPersonal !== undefined && nonPersonal !== null
      ? { [NON_PERSONAL_FIELDS_CONFIG_KEY]: nonPersonal }
      : {}),
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
