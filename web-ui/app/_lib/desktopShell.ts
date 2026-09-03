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

function bridgeHost(): BridgeHost | undefined {
  return typeof window === 'undefined' ? undefined : (window as unknown as BridgeHost);
}
