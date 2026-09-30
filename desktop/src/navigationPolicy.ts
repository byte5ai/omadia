/**
 * Where the shell's windows may go. The pure half; `navigationGuards.ts` wires
 * it to every webContents.
 *
 * Nothing restricted navigation before. A link in a chat answer, a plugin
 * author's homepage or an IdP logout URL replaced the web UI in the app
 * window, and `target="_blank"` opened Electron windows for any site. The
 * rules now:
 *
 *  - In place, the window stays on the app's own loopback origins: the web UI
 *    and the kernel (Entra callback, signed diagram URLs).
 *  - Any other `http:`/`https:` link opens in the system browser.
 *  - Every other scheme is refused: `javascript:`, `data:`, `blob:`, `about:`,
 *    custom schemes, and `file:`. No page may navigate to a file. Main shows
 *    the bundled pages with `loadFile`, which does not pass through here.
 *
 * One exception, decided by the CURRENT document: once a server redirect has
 * taken the window to a foreign page (the in-window OIDC/Entra sign-in), that
 * page's own form posts and hops must stay in the window or the sign-in dies
 * at its first step. From such a page any web target is allowed; script, data
 * and file targets are still refused. The foreign page gets no preload bridge
 * (`bridgeSurface.ts`) and main refuses its IPC (`ipcSender.ts`).
 */

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
