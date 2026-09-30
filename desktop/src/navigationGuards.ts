/**
 * The navigation guards every webContents gets: the main window and any popup
 * it opens. `main.ts` installs them from `app.on('web-contents-created')`,
 * registered before the window exists, so nothing can load unguarded.
 *
 * The rules live in `navigationPolicy.ts`. This module is the Electron glue,
 * with its Electron surface injected (`openExternal`, the log), so a test can
 * drive it without a real `shell` or window.
 *
 *  - `will-navigate` fires for every page-initiated main-frame navigation
 *    (links, `window.location`, form posts), never for main's own
 *    `loadURL`/`loadFile`. The current document decides: from the app or a
 *    bundled page a foreign link is prevented and handed to the system
 *    browser; from a foreign page reached by a redirect (an IdP mid sign-in)
 *    web targets stay in the window.
 *  - Server redirects (`will-redirect`) are deliberately not guarded, so the
 *    in-window OIDC/Entra sign-in keeps working. A foreign document reached
 *    that way gets no bridge, and main refuses its IPC.
 *  - `setWindowOpenHandler` decides by target. A same-app popup (a chat
 *    attachment, the builder preview, a download) opens as a sandboxed child
 *    without a preload, so it carries no bridge. Electron merges only
 *    security-related webPreferences from the parent into such a child and
 *    never the preload, so leaving `preload` out is what matters; the explicit
 *    flags are belt and braces. `about:blank` and an empty `window.open()` are
 *    refused: Electron gives such a child the parent's webPreferences, preload
 *    included, and it shares the opener's origin. Anything else opens in the
 *    system browser.
 */
import type { WindowOpenHandlerResponse } from 'electron';
import {
  decideNavigation,
  decideNavigationFrom,
  isSafeForExternalOpen,
  type NavigationVerdict,
  type TrustedTargets,
} from './navigationPolicy';

/** The part of Electron's will-navigate event read here (`details.url`, not the deprecated positional one). */
export interface WillNavigateEvent {
  readonly url: string;
  preventDefault(): void;
}

/** The part of `WebContents` the guards use. */
export interface GuardableContents {
  getURL(): string;
  on(event: 'will-navigate', listener: (event: WillNavigateEvent) => void): unknown;
  setWindowOpenHandler(
    handler: (details: { readonly url: string }) => WindowOpenHandlerResponse,
  ): void;
}

export interface NavigationGuardDeps {
  /** Read per event: the web UI's origin is only known once it is serving. */
  trusted(): TrustedTargets;
  /** `shell.openExternal`. */
  openExternal(url: string): Promise<void>;
  log: {
    info(message: string): void;
    warn(message: string): void;
  };
}

export function installNavigationGuards(contents: GuardableContents, deps: NavigationGuardDeps): void {
  contents.on('will-navigate', (event) => {
    const target = event.url;
    const verdict = decideNavigationFrom(currentDocument(contents), target, deps.trusted());
    if (verdict === 'allow') return;
    event.preventDefault();
    divert(verdict, target, deps);
  });

  contents.setWindowOpenHandler(({ url }) => {
    const verdict = decideNavigation(url, deps.trusted());
    if (verdict === 'allow') return sameAppPopup();
    // Hand off after the handler has returned, not from inside it.
    setImmediate(() => divert(verdict, url, deps));
    return { action: 'deny' };
  });
}

/** A same-app popup: sandboxed, isolated, and without a preload. */
function sameAppPopup(): WindowOpenHandlerResponse {
  return {
    action: 'allow',
    overrideBrowserWindowOptions: {
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    },
  };
}

/** Open a refused web link in the system browser, or just say it was blocked. */
function divert(verdict: NavigationVerdict, url: string, deps: NavigationGuardDeps): void {
  const where = describeTarget(url);
  if (verdict !== 'open-external' || !isSafeForExternalOpen(url)) {
    deps.log.warn(`[nav] blocked ${where}`);
    return;
  }
  deps.log.info(`[nav] opening ${where} in the system browser`);
  deps.openExternal(url).catch(() => {
    deps.log.warn(`[nav] the system browser did not open ${where}`);
  });
}

/** `getURL()` throws on a destroyed webContents; treat that like the app (strict rules). */
function currentDocument(contents: GuardableContents): string {
  try {
    return contents.getURL();
  } catch {
    return '';
  }
}

/**
 * Where a URL points, for the log. Never the full URL: an OAuth code, a token
 * or an IdP `id_token_hint` rides in the query.
 */
function describeTarget(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.origin !== 'null' ? parsed.origin : `a URL with scheme ${parsed.protocol}`;
  } catch {
    return 'an unparsable URL';
  }
}
