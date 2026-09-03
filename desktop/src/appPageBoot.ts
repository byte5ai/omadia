/**
 * The one sequence that puts the web UI on screen and then speaks (OM-71).
 *
 *   arm the ready gate → load the app URL → mark the shell running →
 *   wait for the UI's ready ping (or the fallback) → remind about the key.
 *
 * Boot and restart both did this by hand, and both got the order wrong in the
 * same way: the reminder followed `loadURL`, which resolves on the document,
 * not on a screen. One function, called from both paths, so the order can be
 * tested once and cannot drift apart again.
 */
import type { UiReadyGate, UiReadyOutcome } from './uiReadyGate';

export interface ShowAppPageDeps {
  readonly gate: UiReadyGate;
  /** `win.loadURL(uiUrl)`. */
  loadApp(): Promise<void>;
  /** Runs as soon as the document is up (tray to "running"). */
  onLoaded(): void;
  /** The recovery-key reminder; only reached once the page is standing. */
  remind(): Promise<void>;
}

/**
 * Returns how the wait ended. `superseded` means a newer navigation replaced
 * this one while we waited; the reminder then belongs to that one, not to us.
 */
export async function showAppPage(deps: ShowAppPageDeps): Promise<UiReadyOutcome> {
  // Armed BEFORE the load so a fast renderer cannot ping into the void.
  const ready = deps.gate.arm();
  await deps.loadApp();
  deps.onLoaded();
  const outcome = await ready;
  if (outcome !== 'superseded') await deps.remind();
  return outcome;
}
