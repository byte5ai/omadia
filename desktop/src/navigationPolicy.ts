/**
 * Where the shell's windows may go. The pure half; `navigationGuards.ts` wires
 * it to every webContents and its session.
 *
 * Nothing restricted navigation before. A link in a chat answer, a plugin
 * author's homepage or an IdP logout URL replaced the web UI in the app
 * window, and `target="_blank"` opened Electron windows for any site. The
 * rules now, per path:
 *
 *  - Main frame, in place (`will-navigate`): the window stays on the app's own
 *    loopback origins, the web UI and the kernel (Entra callback, signed
 *    diagram URLs). Any other `http:`/`https:` link opens in the system
 *    browser. Every other scheme is refused: `javascript:`, `data:`, `blob:`,
 *    `about:`, custom schemes, and `file:`. No page may navigate to a file.
 *    Main shows the bundled pages with `loadFile`, which does not pass through
 *    here.
 *  - Popups (`window.open`, `target="_blank"`): decided by target the same way.
 *  - Subframes (plugin UIs, the builder preview, anything a page embeds) may
 *    show any web page, as in a browser, and what the browser renders in the
 *    page itself (`about:`, `data:`, `blob:`). A custom scheme or `file:` is
 *    refused.
 *  - Server redirects, in any frame, may lead to web URLs only.
 *  - Last, the OS itself. Electron hands a non-web URL to the OS protocol
 *    handler only after asking for the `openExternal` permission, which it
 *    grants when no handler is set. That permission is never granted, so no
 *    page can launch another program (`ms-settings:`, `search-ms:`, any
 *    installed app's scheme), whatever path the rules above might miss. Vetted
 *    web links reach the system browser through `shell.openExternal`, which
 *    does not ask for it. Every other permission is deny by default as well:
 *    only an allowlisted one, for the main frame of one of the app's own
 *    documents (`canGrantPermission`).
 *
 * One exception, decided by the CURRENT document: once a server redirect has
 * taken the window to a foreign page (the in-window OIDC/Entra sign-in), that
 * page's own form posts and hops must stay in the window or the sign-in dies
 * at its first step. From such a page any web target is allowed; script, data
 * and file targets are still refused. The foreign page gets no preload bridge
 * (`bridgeSurface.ts`) and main refuses its IPC (`ipcSender.ts`).
 */
import { WIZARD_PAGE } from './bridgeSurface';
import { isBundledPage } from './ipcSender';

export interface TrustedTargets {
  /** Origins the app serves itself: the kernel and, once it is up, the web UI. */
  readonly origins: readonly string[];
}

export type NavigationVerdict = 'allow' | 'open-external' | 'deny';

const WEB_PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:']);

function parse(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function isWebUrl(url: URL | null): url is URL {
  return url !== null && WEB_PROTOCOLS.has(url.protocol);
}

/** The origin of a web URL; null for anything else (including `null`). */
export function originOf(url: string | null): string | null {
  if (url === null) return null;
  const parsed = parse(url);
  return isWebUrl(parsed) ? parsed.origin : null;
}

/** The trust set for a kernel origin and the web UI's URL (null while none serves). */
export function trustedTargetsFor(kernelOrigin: string, uiUrl: string | null): TrustedTargets {
  const ui = originOf(uiUrl);
  return { origins: ui === null ? [kernelOrigin] : [kernelOrigin, ui] };
}

/** Where a navigation or popup started by a trusted document may go. */
export function decideNavigation(url: string, trusted: TrustedTargets): NavigationVerdict {
  const target = parse(url);
  if (!isWebUrl(target)) return 'deny';
  return trusted.origins.includes(target.origin) ? 'allow' : 'open-external';
}

/**
 * Whether the window is on a foreign web page, i.e. was taken there by a
 * redirect. The app, the bundled pages and a blank or unreadable window are
 * all treated as trusted, so they get the strict rules.
 */
export function isForeignDocument(currentUrl: string, trusted: TrustedTargets): boolean {
  const origin = originOf(currentUrl);
  return origin !== null && !trusted.origins.includes(origin);
}

/** Where a main-frame navigation may go, judged from the document starting it. */
export function decideNavigationFrom(
  currentUrl: string,
  targetUrl: string,
  trusted: TrustedTargets,
): NavigationVerdict {
  if (!isForeignDocument(currentUrl, trusted)) return decideNavigation(targetUrl, trusted);
  return isWebUrl(parse(targetUrl)) ? 'allow' : 'deny';
}

/** The last check before `shell.openExternal`: only web links reach the OS. */
export function isSafeForExternalOpen(url: string): boolean {
  return isWebUrl(parse(url));
}

/** What the browser renders inside the page itself; never handed to the OS. */
const IN_PAGE_PROTOCOLS: ReadonlySet<string> = new Set(['about:', 'data:', 'blob:']);

/**
 * Where a subframe may navigate. An iframe may show any web page, as in a
 * browser: it stays inside its frame and never gets the bridge (the preload
 * runs in main frames only). It may not hand a URL to the OS protocol handler
 * or open a file.
 */
export function canSubframeLoad(url: string): boolean {
  const target = parse(url);
  if (target === null) return false;
  return WEB_PROTOCOLS.has(target.protocol) || IN_PAGE_PROTOCOLS.has(target.protocol);
}

/**
 * Where a server redirect may lead, in any frame. The in-window sign-in is a
 * chain of web redirects, so those stay allowed; a redirect to any other scheme
 * would reach the OS protocol handler. (Chromium itself refuses redirects to
 * `data:`, `file:` and the like.)
 */
export function canRedirectTo(url: string): boolean {
  return isWebUrl(parse(url));
}

/**
 * The permissions a page can be granted; every other one is refused. Each
 * entry names the call sites that need it. A new call site of a
 * permission-gated web API (camera or microphone, screen capture, fullscreen,
 * notifications, location, reading the clipboard, ...) does not work in the
 * app until its permission is added here, with its call sites.
 *
 * Never on this list: `openExternal`, which would let a page make the OS
 * protocol handler launch a program, and `deprecated-sync-clipboard-read`.
 */
export const GRANTABLE_PERMISSIONS: ReadonlySet<string> = new Set([
  // `navigator.clipboard.writeText` behind the copy buttons of
  //  - the web UI:
  //      web-ui/app/admin/api-keys/_components/ApiKeysPanel.tsx (a new key's token)
  //      web-ui/app/admin/api-keys/_components/shared.tsx (a key id)
  //      web-ui/app/memories/[id]/page.tsx (a memory excerpt)
  //      web-ui/app/operator/agents/[slug]/_components/AgentTeamsIdentity.tsx (the Teams config block)
  //      web-ui/app/operator/privacy-reports/_components/MissReportList.tsx (a missed term)
  //      web-ui/app/operator/teams/_components/TeamsTenantSignIn.tsx (the device-login code)
  //      web-ui/app/store/builder/[id]/_components/PreviewPromptPanel.tsx (the system prompt)
  //  - the bundled wizard: desktop/src/renderer/wizard.js (the recovery key)
  'clipboard-sanitized-write',
]);

/** What a permission decision reads about the frame that asked. */
export interface PermissionRequester {
  /** The URL of the requesting frame's document; '' when it is unknown. */
  readonly url: string;
  readonly isMainFrame: boolean;
}

/** Where the app's own documents live, the only ones a permission is granted to. */
export interface AppDocuments {
  /** The kernel and, once it is up, the web UI (`trustedTargetsFor`). */
  readonly trusted: TrustedTargets;
  /** Absolute path of the bundled renderer pages (`<app>/dist/renderer`). */
  readonly rendererDir: string;
}

/**
 * Whether a page gets a permission, deny by default: only when the permission
 * is on the allowlist and the main frame of one of the app's own documents
 * asks. Electron's answer without a handler was to grant everything, to every
 * frame: camera, microphone, location and notifications to plugin iframes,
 * same-app popups and foreign pages reached by a redirect.
 *
 * The one rule answers both Electron paths: permission requests and
 * permission checks. Most web APIs check first and ask only when the check
 * fails, so a check that passed where a request is refused would skip the
 * gate.
 *
 * Subframes never get a permission, not even on the web UI's own origin: plugin
 * UIs and the builder preview run there, and a grant for the origin would be a
 * grant for them.
 */
export function canGrantPermission(
  permission: string,
  requester: PermissionRequester,
  app: AppDocuments,
): boolean {
  return GRANTABLE_PERMISSIONS.has(permission) && requester.isMainFrame && isAppDocument(requester.url, app);
}

/**
 * The app's own documents: a page on one of its trusted origins, the kernel or
 * the running web UI, which is where `decideNavigation` keeps the window; and
 * the bundled wizard, compared by file path against the install, as
 * `ipcSender.ts` does before it answers the wizard's IPC. Not the bundled
 * loading page, which uses no permission. Not a foreign page reached by a
 * redirect, any other `file:`, `about:blank` or an unreadable URL.
 */
function isAppDocument(url: string, app: AppDocuments): boolean {
  return decideNavigation(url, app.trusted) === 'allow' || isBundledPage(url, app.rendererDir, WIZARD_PAGE);
}
