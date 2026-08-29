/**
 * The live navigation state, and the logging around it (OM-58).
 *
 * `shellView.ts` holds the pure rules; this owns the one mutable `ViewState` the
 * shell actually runs on, so `main.ts` never touches it directly. Keeping the
 * two apart matters because the rules are the part worth unit-testing and the
 * state is the part worth having exactly one of.
 *
 * Every refusal is logged here rather than at the call sites. A silently dropped
 * navigation is precisely how the wizard-overwrite bug hid, and centralising it
 * means a new navigation path cannot forget to say when it was denied.
 */
import { log } from './log';
import {
  abandonNavigation,
  beginNavigation,
  commitNavigation,
  initialViewState,
  mayCommitNavigation,
  mayStartNavigation,
  type NavSource,
  type ShellView,
  type ViewState,
} from './shellView';

let viewState: ViewState = initialViewState();

/** What the window is showing right now. */
export function currentView(): ShellView {
  return viewState.showing;
}

/**
 * Take ownership of the window for `source`, or refuse.
 *
 * Returns the token to hand back to {@link finishNavigation}, or `null` when the
 * arbiter refused.
 */
export function startNavigation(target: ShellView, source: NavSource): number | null {
  const decision = mayStartNavigation(viewState, source);
  if (!decision.allowed) {
    log.warn(`[main] navigation refused: ${decision.reason}`);
    return null;
  }
  const next = beginNavigation(viewState, target);
  viewState = next.state;
  return next.token;
}

/** Whether a navigation that began with `token` may still commit. */
export function finishNavigation(
  token: number,
  target: ShellView,
  source: NavSource,
): boolean {
  const decision = mayCommitNavigation(viewState, token, source);
  if (!decision.allowed) {
    log.warn(`[main] navigation not committed: ${decision.reason}`);
    return false;
  }
  viewState = commitNavigation(viewState, target);
  return true;
}

/**
 * Release a claim whose load rejected.
 *
 * Always to a view that leaves the shell recoverable — never back to the view
 * just claimed, which would be a no-op and freeze the arbiter there.
 */
export function abandonNavigationTo(token: number, fallback: ShellView): void {
  viewState = abandonNavigation(viewState, token, fallback);
}
