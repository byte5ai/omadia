/**
 * Environment defaults the desktop shell imposes on the kernel it spawns.
 *
 * The kernel's own defaults are tuned for self-hosters on a LAN. Some of them
 * are wrong for a single-user app where user and services share one machine.
 * Each entry here says which default it overrides and why; an explicit value in
 * the user's environment always wins, so an operator can still opt back in.
 */

import path from 'node:path';

import { log } from './log';

/** The slice of the kernel env this module decides. */
export interface DesktopKernelEnvDefaults {
  readonly OMADIA_UI_MDNS_ENABLED: 'true' | 'false';
}

/**
 * OM-70 (#1004): the kernel advertises `_omadia._tcp` over mDNS by default so a
 * desktop client can discover a self-hosted kernel on the LAN. Inside the
 * desktop app there is nothing to discover, and the second responder claimed
 * the Mac's own `<LocalHostName>.local`; macOS treated it as a foreign device
 * and renamed the machine on every start (`-8` → `-9` → `-10`). Off unless the
 * user set it themselves.
 */
export function desktopKernelEnvDefaults(
  userEnv: NodeJS.ProcessEnv,
): DesktopKernelEnvDefaults {
  const explicit = userEnv['OMADIA_UI_MDNS_ENABLED'];
  if (explicit === 'true' || explicit === 'false') return { OMADIA_UI_MDNS_ENABLED: explicit };
  if (explicit !== undefined && explicit !== '') {
    // The kernel parses `z.enum(['true','false'])`; anything else would take the
    // boot down. Falling back to off is the safe reading, but an opt-in typo
    // (`1`, `TRUE`) must not vanish silently.
    log.warn(
      `[supervisor] OMADIA_UI_MDNS_ENABLED=${JSON.stringify(explicit)} is not 'true' or 'false'; ` +
        'the mDNS advertiser stays off',
    );
  }
  return { OMADIA_UI_MDNS_ENABLED: 'false' };
}

/** What only the packaged app sets; a dev run keeps the kernel's own defaults. */
export interface PackagedRuntime {
  readonly packaged: boolean;
  readonly version: string;
  readonly kernelCwd: string;
}

/**
 * The version the kernel and the web UI report. CI stamps it into the desktop
 * package only, so without this the update page and `/health` say "unknown".
 * Dev reports nothing: its package.json carries a placeholder version.
 */
export function packagedVersionEnv(runtime: PackagedRuntime): { OMADIA_VERSION?: string } {
  return runtime.packaged ? { OMADIA_VERSION: `v${runtime.version}` } : {};
}

/**
 * Load the built-in plugins from the directory `@omadia/*` imports resolve to.
 * `stage-runtime.mjs` has to replace the workspace symlinks with real copies,
 * which leaves each package twice, and Node keys modules by real path. With the
 * kernel's default `./packages` the orchestrator plugin and the kernel each got
 * their own module instance, so the kernel never saw the plugin's
 * AsyncLocalStorage scopes (`turnContext.currentAgentSlug()` was always empty).
 */
export function packagedPackagesEnv(runtime: PackagedRuntime): { BUILT_IN_PACKAGES_DIR?: string } {
  return runtime.packaged
    ? { BUILT_IN_PACKAGES_DIR: path.join(runtime.kernelCwd, 'node_modules', '@omadia') }
    : {};
}
