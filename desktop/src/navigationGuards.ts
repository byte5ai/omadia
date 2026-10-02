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
 *  - `will-frame-navigate` fires for page-initiated navigations in any frame.
 *    The main frame is left to `will-navigate`; a subframe (a plugin UI, the
 *    builder preview) may load web pages and in-page documents, never a
 *    custom scheme or a file.
 *  - `will-redirect` fires for server redirects in any frame. Web redirects
 *    pass, so the in-window OIDC/Entra sign-in keeps working (a foreign
 *    document reached that way gets no bridge, and main refuses its IPC); a
 *    redirect to any other scheme cancels the navigation.
 *  - `setWindowOpenHandler` decides by target. A same-app popup (a chat
 *    attachment, the builder preview, a download) opens as a sandboxed child
 *    without a preload, so it carries no bridge. Electron merges only
 *    security-related webPreferences from the parent into such a child and
 *    never the preload, so leaving `preload` out is what matters; the explicit
 *    flags are belt and braces. `about:blank` and an empty `window.open()` are
 *    refused: Electron gives such a child the parent's webPreferences, preload
 *    included, and it shares the opener's origin. Anything else opens in the
 *    system browser.
 *  - The contents' session never grants the `openExternal` permission, which
 *    is how Electron hands any non-web URL to the OS protocol handler. That is
 *    the backstop behind the event guards: whatever a page does, it cannot make
 *    the OS launch a program. Every other permission request and check is
 *    refused too, unless the permission is on the allowlist and the main frame
 *    of one of the app's own documents asks (`canGrantPermission`).
 */
import type { WindowOpenHandlerResponse } from 'electron';
import {
  canGrantPermission,
  canRedirectTo,
  canSubframeLoad,
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

/** The part of Electron's will-frame-navigate and will-redirect events read here. */
export interface FrameNavigationEvent extends WillNavigateEvent {
  readonly isMainFrame: boolean;
}

/** The part of a permission request's details read here. */
export interface PermissionRequestDetails {
  /** Set by Electron on every request. */
  readonly isMainFrame: boolean;
  /** The URL of the requesting frame's document. Without it, the window's URL counts. */
  readonly requestingUrl?: string;
  /** The URL the OS would be handed, on an `openExternal` request. */
  readonly externalURL?: string;
}

/** The part of a permission check's details read here. */
export interface PermissionCheckDetails {
  readonly isMainFrame: boolean;
  /** The URL of the requesting frame's document; Electron leaves it out for a check made for no document. */
  readonly requestingUrl?: string;
}

/** The part of the `WebContents` that Electron hands a permission handler. */
export interface PermissionContents {
  getURL(): string;
}

/** The part of `Session` the guards use. */
export interface GuardableSession {
  setPermissionRequestHandler(
    handler: (
      contents: PermissionContents | null,
      permission: string,
      callback: (granted: boolean) => void,
      details: PermissionRequestDetails,
    ) => void,
  ): void;
  setPermissionCheckHandler(
    handler: (
      contents: PermissionContents | null,
      permission: string,
      requestingOrigin: string,
      details: PermissionCheckDetails,
    ) => boolean,
  ): void;
}

/** The part of `WebContents` the guards use. */
export interface GuardableContents {
  readonly session: GuardableSession;
  getURL(): string;
  on(event: 'will-navigate', listener: (event: WillNavigateEvent) => void): unknown;
  on(event: 'will-frame-navigate', listener: (event: FrameNavigationEvent) => void): unknown;
  on(event: 'will-redirect', listener: (event: FrameNavigationEvent) => void): unknown;
  setWindowOpenHandler(
    handler: (details: { readonly url: string }) => WindowOpenHandlerResponse,
  ): void;
}

export interface NavigationGuardDeps {
  /** Read per event: the web UI's origin is only known once it is serving. */
  trusted(): TrustedTargets;
  /** Absolute path of the bundled renderer pages (`<app>/dist/renderer`); the wizard among them may copy. */
  readonly rendererDir: string;
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

  contents.on('will-frame-navigate', (event) => {
    if (event.isMainFrame || canSubframeLoad(event.url)) return;
    event.preventDefault();
    deps.log.warn(`[nav] blocked a subframe navigation to ${describeTarget(event.url)}`);
  });

  contents.on('will-redirect', (event) => {
    if (canRedirectTo(event.url)) return;
    // Cancels the whole navigation; the frame keeps its current document.
    event.preventDefault();
    deps.log.warn(`[nav] blocked a redirect to ${describeTarget(event.url)}`);
  });

  contents.setWindowOpenHandler(({ url }) => {
    const verdict = decideNavigation(url, deps.trusted());
    if (verdict === 'allow') return sameAppPopup();
    // Hand off after the handler has returned, not from inside it.
    setImmediate(() => divert(verdict, url, deps));
    return { action: 'deny' };
  });

  installPermissionGuards(contents.session, deps);
}

/**
 * Deny every permission on a session unless `canGrantPermission` allows it:
 * an allowlisted permission, for the main frame of one of the app's own
 * documents. Requests and checks get the same answer; only a refused request
 * is logged, as checks come often and unprompted. Set for the session of every
 * guarded webContents (all of them share the default session today, and
 * setting it again is harmless), so a window on another session cannot slip
 * past. The trust set is read per call, like the navigation guards do.
 */
function installPermissionGuards(session: GuardableSession, deps: NavigationGuardDeps): void {
  const decide = (permission: string, url: string, isMainFrame: boolean): boolean =>
    canGrantPermission(
      permission,
      // The details come from Electron; a flag it left out reads as a subframe.
      { url, isMainFrame: isMainFrame === true },
      { trusted: deps.trusted(), rendererDir: deps.rendererDir },
    );

  session.setPermissionRequestHandler((contents, permission, callback, details) => {
    const url = requestingDocument(contents, details.requestingUrl);
    const granted = decide(permission, url, details.isMainFrame);
    if (!granted) {
      const frame = details.isMainFrame ? 'main frame' : 'subframe';
      // On openExternal, where it would have gone; otherwise who asked.
      deps.log.warn(`[nav] refused ${permission} for ${describeTarget(details.externalURL ?? url)} (${frame})`);
    }
    callback(granted);
  });
  session.setPermissionCheckHandler((contents, permission, _requestingOrigin, details) =>
    decide(permission, requestingDocument(contents, details.requestingUrl), details.isMainFrame),
  );
}

/**
 * The document a permission is asked for: the requesting frame's own URL, as
 * Electron reports it; failing that, what the window shows. No window, or one
 * that cannot be read, is no document of the app's.
 */
function requestingDocument(contents: PermissionContents | null, requestingUrl: string | undefined): string {
  if (requestingUrl) return requestingUrl;
  return contents === null ? '' : currentDocument(contents);
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

/**
 * `getURL()` throws on a destroyed webContents. Read as '': the strict rules
 * for a navigation, no app document for a permission.
 */
function currentDocument(contents: PermissionContents): string {
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
