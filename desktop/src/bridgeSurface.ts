/**
 * Which slice of the renderer bridge a document gets.
 *
 * The shell shows every page in ONE window with ONE preload: the bundled
 * first-run wizard and loading screen (`file:`), the loopback web UI once the
 * stack is up, and whatever a server redirect lands the window on (an IdP
 * sign-in page). `webPreferences.preload` is fixed per webContents, so the
 * preload itself has to decide what the document in front of it may call,
 * before any page script runs:
 *
 *  - `wizard` — the bundled wizard: setup methods plus the boot stream.
 *  - `boot`   — the bundled loading screen: the boot stream only.
 *  - `app`    — the loopback web UI: `uiReady` / `setUiLocale`, nothing that
 *               returns or writes a secret.
 *  - `none`   — anything else: no bridge at all.
 *
 * This is defence in depth, not the boundary. A URL is all the preload can
 * see, so a file named `wizard.html` anywhere on disk classifies as `wizard`
 * here, and any loopback port as `app`. Main checks every call's sender frame
 * against the real install path, the web UI's real origin and the app state
 * (`ipcSender.ts`); that check is what refuses a document.
 *
 * NO IMPORTS, on purpose: this module is inlined into the SANDBOXED preload
 * (`scripts/bundle-preload.mjs`), which can `require('electron')` and nothing
 * else. A `node:` import here would make the preload fail to load and leave
 * the wizard without a bridge. Only the WHATWG `URL` global is used.
 */

export type BridgeSurface = 'wizard' | 'boot' | 'app' | 'none';

/** The bundled first-run wizard page (`dist/renderer/`). */
export const WIZARD_PAGE = 'wizard.html';
/** The bundled loading screen shown while an existing install boots. */
export const LOADING_PAGE = 'loading.html';

/** The only host the web UI and the kernel listen on (`supervisor.ts`). */
const LOOPBACK_HOST = '127.0.0.1';

export function bridgeSurfaceFor(href: string): BridgeSurface {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return 'none';
  }
  if (url.protocol === 'file:') {
    // `?log=` and `#recovered` live outside the pathname, so they never matter.
    if (url.pathname.endsWith(`/${WIZARD_PAGE}`)) return 'wizard';
    if (url.pathname.endsWith(`/${LOADING_PAGE}`)) return 'boot';
    return 'none';
  }
  if (url.protocol === 'http:' && url.hostname === LOOPBACK_HOST) return 'app';
  return 'none';
}
