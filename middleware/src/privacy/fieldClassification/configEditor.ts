/**
 * Field classification — the ONE writer of the privacy guard's
 * `non_personal_fields`: a read-modify-write through the installed-registry
 * update the `PATCH /admin/runtime/installed/:id/config` route uses,
 * serialized per plugin id. The admin routes (decision, legacy conversion,
 * bulk accept / undo) and the recompute's auto-approval share one instance,
 * so their writes never interleave.
 *
 * Known race (L3, accepted): the lock only orders writes made through this
 * editor. A concurrent `PATCH /admin/runtime/installed/:id/config` (the
 * generic plugin settings form) is not serialized against it, so one of the
 * two writes can overwrite the other's `non_personal_fields`. Both outcomes
 * fail safe — a lost append leaves the field masked, a lost removal is
 * visible on the page as still confirmed — so it is left as is.
 */

import type { InstalledRegistry } from '../../plugins/installedRegistry.js';
import type { PluginCatalog } from '../../plugins/manifestLoader.js';
import { autoApproveSettingsOf, type AutoApproveSettings } from './autoApprove.js';
import { NON_PERSONAL_FIELDS_KEY, privacyGuardInstalledId } from './guardConfig.js';

/** A refused edit; `body` is the 409 response the routes send. */
export class ConfigEditConflict extends Error {
  constructor(readonly body: Record<string, unknown>) {
    super(String(body['error']));
    this.name = 'ConfigEditConflict';
  }
}

export interface ConfigChange {
  readonly before: string;
  readonly after: string;
  readonly guardId: string;
}

export interface NonPersonalFieldsEditor {
  /** Run `edit` on the current value under the plugin lock and store the
   *  result when it differs. `edit` may throw to refuse (nothing is written);
   *  it may be async — e.g. to re-read a decision inside the lock.
   *  Throws `ConfigEditConflict({ error: 'privacy_guard_not_installed' })`
   *  without a guard. */
  edit(edit: (before: string) => string | Promise<string>): Promise<ConfigChange>;
  /** The guard's auto-approval settings, read now. */
  autoApproveSettings(): AutoApproveSettings;
}

function createKeyedMutex(): <T>(key: string, fn: () => Promise<T>) => Promise<T> {
  const tails = new Map<string, Promise<unknown>>();
  return async <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const previous = tails.get(key) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    const tail = run.catch(() => undefined);
    tails.set(key, tail);
    try {
      return await run;
    } finally {
      if (tails.get(key) === tail) tails.delete(key);
    }
  };
}

export function createNonPersonalFieldsEditor(deps: {
  readonly installedRegistry: Pick<InstalledRegistry, 'list' | 'get' | 'updateConfig'>;
  readonly catalog?: Pick<PluginCatalog, 'get'>;
}): NonPersonalFieldsEditor {
  const withPluginLock = createKeyedMutex();
  const notInstalled = (): ConfigEditConflict =>
    new ConfigEditConflict({ error: 'privacy_guard_not_installed' });
  return {
    async edit(edit) {
      const guardId = privacyGuardInstalledId(deps.installedRegistry, deps.catalog);
      if (guardId === undefined) throw notInstalled();
      return withPluginLock(guardId, async () => {
        const entry = deps.installedRegistry.get(guardId);
        if (entry === undefined) throw notInstalled();
        const current = entry.config[NON_PERSONAL_FIELDS_KEY];
        const before = typeof current === 'string' ? current : '';
        const after = await edit(before);
        if (after !== before) {
          const nextConfig: Record<string, unknown> = { ...entry.config };
          if (after.length === 0) delete nextConfig[NON_PERSONAL_FIELDS_KEY];
          else nextConfig[NON_PERSONAL_FIELDS_KEY] = after;
          await deps.installedRegistry.updateConfig(guardId, nextConfig);
        }
        return { before, after, guardId };
      });
    },
    autoApproveSettings() {
      const guardId = privacyGuardInstalledId(deps.installedRegistry, deps.catalog);
      const config = guardId !== undefined ? deps.installedRegistry.get(guardId)?.config : undefined;
      return autoApproveSettingsOf(config);
    },
  };
}
