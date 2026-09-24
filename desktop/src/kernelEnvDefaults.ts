/**
 * Environment defaults the desktop shell imposes on the kernel it spawns.
 *
 * The kernel's own defaults are tuned for self-hosters on a LAN. Some of them
 * are wrong for a single-user app where user and services share one machine.
 * Each entry here says which default it overrides and why; an explicit value in
 * the user's environment always wins, so an operator can still opt back in.
 */

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
