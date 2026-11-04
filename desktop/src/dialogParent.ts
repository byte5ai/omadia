/** The structural slice of `BrowserWindow` this decision needs. */
export interface DialogParentCandidate {
  isDestroyed(): boolean;
}

/**
 * The window a dialog attaches to, if any. A dialog with no parent runs the
 * native modal loop on macOS: the main process stands still until it is answered,
 * so nothing reaches the app, not even a quit or SIGTERM. Attached to a window it
 * is a sheet and the main process keeps running. The caller brings the window
 * forward, because closing it only hides it and a sheet on it would wait unseen.
 */
export function dialogParent<T extends DialogParentCandidate>(
  windows: readonly T[],
): T | undefined {
  return windows.find((w) => !w.isDestroyed());
}
