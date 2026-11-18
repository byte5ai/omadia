/**
 * Field classification — where the privacy guard's `non_personal_fields`
 * setting lives: the installed-registry config of the plugin that provides
 * the Privacy Shield capability.
 */

import type { InstalledRegistry } from '../../plugins/installedRegistry.js';
import type { PluginCatalog } from '../../plugins/manifestLoader.js';
import {
  NON_PERSONAL_FIELDS_CONFIG_KEY,
  privacyProviderIds,
} from '../../plugins/privacyPosture.js';

/** The config key on the privacy-guard plugin (`nonPersonalFields.ts`). */
export const NON_PERSONAL_FIELDS_KEY = NON_PERSONAL_FIELDS_CONFIG_KEY;

/** The bundled guard's id — the fallback when no catalog is wired. */
export const DEFAULT_PRIVACY_GUARD_ID = '@omadia/plugin-privacy-guard';

/**
 * The installed id of the privacy guard: an ACTIVE capability provider
 * first, any installed provider next, the bundled id when it is installed.
 */
export function privacyGuardInstalledId(
  installedRegistry: Pick<InstalledRegistry, 'list' | 'get'>,
  catalog: Pick<PluginCatalog, 'get'> | undefined,
): string | undefined {
  const providers = privacyProviderIds(installedRegistry, catalog);
  const active = providers.find((id) => installedRegistry.get(id)?.status === 'active');
  if (active !== undefined) return active;
  if (providers[0] !== undefined) return providers[0];
  return installedRegistry.get(DEFAULT_PRIVACY_GUARD_ID) ? DEFAULT_PRIVACY_GUARD_ID : undefined;
}

/** The guard's current `non_personal_fields` value (raw text). */
export function readNonPersonalFieldsConfig(
  installedRegistry: Pick<InstalledRegistry, 'list' | 'get'>,
  catalog: Pick<PluginCatalog, 'get'> | undefined,
): string | undefined {
  const id = privacyGuardInstalledId(installedRegistry, catalog);
  if (id === undefined) return undefined;
  const value = installedRegistry.get(id)?.config[NON_PERSONAL_FIELDS_KEY];
  return typeof value === 'string' ? value : undefined;
}
