import type { PluginCatalog } from './manifestLoader.js';
import type { InstalledRegistry } from './installedRegistry.js';

/**
 * #1491 / #1498 — one rule for attaching kernel-installed plugins to the
 * default orchestrator (the fallback Agent), used by every install path:
 *
 *  - first boot: `ensureFallbackAgent` attaches every installed plugin;
 *  - boot reconciliation: built-ins the boot installs on an EXISTING instance
 *    (new in the image, a provider swap) are queued here and attached once
 *    the orchestrator's config store exists;
 *  - runtime installs (Hub, upload, store reinstall) of every plugin kind,
 *    not only agents.
 *
 * The plugin is attached together with its installed `depends_on` parents,
 * which is what the manual attach in the "Plugins" tab does. Rows that already
 * exist are never rewritten (see `attachNewPluginsToFallbackAgent`).
 */

/**
 * `pluginIds` plus their installed `depends_on` ancestors, parents first.
 * Parents that are not installed are left out: a row for a missing plugin
 * would be a dangling grant.
 */
export function withInstalledParents(
  pluginIds: readonly string[],
  catalog: Pick<PluginCatalog, 'get'>,
  registry: Pick<InstalledRegistry, 'has'>,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const visit = (id: string): void => {
    if (seen.has(id)) return;
    seen.add(id);
    for (const parent of catalog.get(id)?.plugin.depends_on ?? []) {
      if (registry.has(parent)) visit(parent);
    }
    out.push(id);
  };
  for (const id of pluginIds) visit(id);
  return out;
}

/**
 * Attach the given plugins (already parent-expanded or not — the host
 * expands) to the default orchestrator. Answers `false` when it could not run
 * yet because the orchestrator's config store does not exist (key-less boot,
 * no database); `true` once it ran, whatever it attached.
 */
export type DefaultOrchestratorAttach = (
  pluginIds: readonly string[],
) => Promise<boolean>;

/**
 * Boot-time queue for {@link DefaultOrchestratorAttach}. The boot seeders run
 * before `@omadia/orchestrator` provides its config store, so ids are queued
 * and attached at the host's flush points — the same points
 * `pendingBindingPurge` uses (after the tool runtime activated, and on every
 * orchestrator (re)activation).
 *
 * In memory only: ids still pending when the process exits stay unattached.
 * That is the key-less-boot-then-restart case; the operator's "Reset standard
 * to all plugins" action covers it.
 */
export interface PendingDefaultAttach {
  enqueue(pluginId: string): void;
  /** Attach every queued id that is still installed. Never rejects. */
  flush(): Promise<void>;
  pending(): readonly string[];
}

export interface PendingDefaultAttachDeps {
  attach: DefaultOrchestratorAttach;
  isInstalled: (pluginId: string) => boolean;
  log?: (msg: string) => void;
}

export function createPendingDefaultAttach(
  deps: PendingDefaultAttachDeps,
): PendingDefaultAttach {
  const log = deps.log ?? ((m: string) => console.log(m));
  const queue = new Set<string>();

  const flush = async (): Promise<void> => {
    if (queue.size === 0) return;
    // Snapshot + clear BEFORE awaiting so a concurrent flush (boot vs. an
    // orchestrator reactivation) does not attach the same ids twice.
    const ids = [...queue].filter((id) => deps.isInstalled(id));
    queue.clear();
    if (ids.length === 0) return;
    let ran: boolean;
    try {
      ran = await deps.attach(ids);
    } catch (err) {
      // Kept for the next flush point (orchestrator reactivation).
      for (const id of ids) queue.add(id);
      log(
        `[bootstrap] default-orchestrator attach FAILED for ${ids.join(', ')} — kept queued: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    if (!ran) {
      for (const id of ids) queue.add(id);
      log(
        `[bootstrap] default-orchestrator attach DEFERRED for ${ids.join(', ')} — no orchestrator config store yet; retries when @omadia/orchestrator activates`,
      );
    }
  };

  return {
    enqueue: (pluginId) => {
      queue.add(pluginId);
    },
    flush,
    pending: () => [...queue],
  };
}
