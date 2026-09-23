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

import type {
  Plugin,
  PluginInstallOrigin,
  PluginInstallState,
} from './storeTypes';

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

/**
 * True when the OPERATOR installed this plugin — #1089.
 *
 * `isInstalled` answers "is it in the registry", which on a fresh Docker
 * Compose deployment is already true for the 16 packages the kernel
 * auto-installs at boot. The onboarding surfaces ask a different question
 * ("has the operator done anything yet"), and reading the first as the second
 * pre-completed dashboard step 3 and pushed the store past the profile
 * modal's threshold, so the curated-profile path was unreachable in the
 * default install.
 *
 * Back-compat: a middleware without #1089 sends no `install_origin` at all.
 * Falling back to `isInstalled` there keeps the old (wrong-but-harmless)
 * behaviour, whereas treating absence as 'bundled' would pop the profile modal
 * over a fully configured deployment — the worse of the two failures.
 *
 * Deliberately a SECOND predicate, not a widening of `isInstalled`: the health
 * tile and the store's "Installiert" tab must keep counting the built-ins,
 * which are genuinely installed.
 */
export function isOperatorInstalled(plugin: {
  install_state: PluginInstallState;
  install_origin?: PluginInstallOrigin;
}): boolean {
  if (!isInstalled(plugin)) return false;
  if (!plugin.install_origin) return true;
  return plugin.install_origin === 'operator';
}
