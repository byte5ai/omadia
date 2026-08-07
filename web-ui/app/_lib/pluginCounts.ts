/**
 * OM-27 — one predicate, three call sites.
 *
 * The store, the dashboard health tile and the orchestrator page each counted
 * plugins with their own inline filter, and the three numbers disagreed:
 *
 *   • dashboard  — `install_state ∈ {installed, update-available}`
 *   • store tab  — `install_state === 'installed'` ONLY, so a locally
 *                  catalogued plugin with a pending update silently dropped out
 *                  of "Installiert" and inflated the "Lokal" bucket
 *   • orchestr.  — `agent.plugins.filter(p => p.enabled)`, which is ATTACHMENT,
 *                  a genuinely different concept that merely looked like the
 *                  same number
 *
 * Centralising the predicate means the first two can no longer drift; the
 * labels (see `store.counts.*` in messages/) make the third read as the
 * different concept it is.
 */

import type { Plugin, PluginInstallState } from './storeTypes';

/**
 * True when the plugin is present in the runtime registry.
 *
 * `update-available` IS installed — it is an installed plugin that additionally
 * has a newer version on a registry. Treating it as anything else is the OM-27
 * bug. Never widen this to consider readiness: presence and usability are
 * separate questions (see `isReady`).
 */
export function isInstalled(plugin: {
  install_state: PluginInstallState;
}): boolean {
  return (
    plugin.install_state === 'installed' ||
    plugin.install_state === 'update-available'
  );
}

/**
 * True when the plugin is installed AND the kernel says it can actually serve
 * a request (OM-16 readiness).
 *
 * Back-compat: a pre-OM-16 middleware omits `readiness` entirely. In that case
 * we fall back to `isInstalled` — reporting "0 of 16 ready" against an older
 * server would be a worse lie than the one readiness fixes.
 */
export function isReady(plugin: Pick<Plugin, 'install_state' | 'readiness'>): boolean {
  if (!isInstalled(plugin)) return false;
  if (!plugin.readiness) return true;
  return plugin.readiness.state === 'ready';
}

/** Convenience pair for the "{n} of {total} ready" label. */
export function countReadiness(
  plugins: ReadonlyArray<Pick<Plugin, 'install_state' | 'readiness'>>,
): { installed: number; ready: number } {
  const installed = plugins.filter(isInstalled);
  return { installed: installed.length, ready: installed.filter(isReady).length };
}
