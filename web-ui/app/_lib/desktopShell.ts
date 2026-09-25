/**
 * The narrow bridge the desktop shell's preload exposes to the web UI.
 *
 * Only present when the page runs inside the omadia desktop app; in a browser
 * `window.omadia` is undefined and every call here is a no-op. Keep this the
 * single place that knows the bridge's shape so a renamed channel breaks one
 * file, not a scattered set of `(window as any)` casts.
 */

interface DesktopBridge {
  /** OM-71: tell the shell the first real screen is standing. */
  readonly uiReady?: () => void;
  /** #1074: tell the shell which language the UI is showing. */
  readonly setUiLocale?: (locale: string) => void;
}

interface BridgeHost {
  readonly omadia?: DesktopBridge;
}

/**
 * Report that the UI is standing, so shell-owned dialogs (the recovery-key
 * reminder) wait for a page instead of a navigation. Returns whether a bridge
 * was there to tell. Never throws: a broken bridge must not take the page down.
 */
export function signalDesktopUiReady(host: BridgeHost | undefined = bridgeHost()): boolean {
  const ping = host?.omadia?.uiReady;
  if (typeof ping !== 'function') return false;
  try {
    ping();
    return true;
  } catch {
    return false;
  }
}

/**
 * Tell the desktop shell which language the UI is showing, so its own dialogs
 * and menu speak it instead of the OS language (#1074). The shell accepts only
 * the locales the UI offers and persists the last one for dialogs that fire
 * before the UI is up. Returns whether a bridge was there to tell (false in a
 * browser, and against an older shell without the channel). Never throws.
 */
export function pushDesktopUiLocale(
  locale: string,
  host: BridgeHost | undefined = bridgeHost(),
): boolean {
  const push = host?.omadia?.setUiLocale;
  if (typeof push !== 'function') return false;
  try {
    push(locale);
    return true;
  } catch {
    return false;
  }
}

function bridgeHost(): BridgeHost | undefined {
  return typeof window === 'undefined' ? undefined : (window as unknown as BridgeHost);
}
