/**
 * Who is allowed to replace what is on screen (OM-58).
 *
 * The shell had THREE independent places that navigated the single window, none
 * of them aware of the others:
 *
 *  1. `bootExistingInstall()` — loading screen, then the app URL.
 *  2. the tray's *Restart* — loading screen, then the app URL.
 *  3. the wizard's `complete` IPC, via `onReady` — the app URL.
 *
 * Each one ended in an unconditional `loadURL`. So a boot finishing while the
 * first-run wizard was open did not cancel the wizard, it OVERWROTE it, and the
 * user landed on the sign-in form mid-setup. That matches the field report
 * exactly (wizard 12:16:16–12:17:41, sign-in 12:18:44) on a machine that was
 * restarting repeatedly because of the update loop.
 *
 * Two consequences made it worse than a cosmetic glitch: the user never reached
 * the data-directory step, and never reached the RECOVERY KEY step — on a
 * product running a local database, silently skipping that is a data-loss risk
 * the affected person does not know about.
 *
 * The fix is an arbiter with two rules:
 *
 *  - **An open wizard is not overwritten.** Only the wizard's own completion,
 *    or a crash recovery (the page is already gone), may replace it.
 *  - **A superseded navigation does not commit.** Every intent takes a token;
 *    a newer intent invalidates older ones, so whichever boot finishes last
 *    cannot stomp the view a newer one established.
 *
 * Pure and Electron-free on purpose: the interesting behaviour is the ordering,
 * and ordering is what tests should be able to drive directly.
 */

/** What the window is showing. */
export type ShellView =
  /** The loading screen, while the stack comes up. */
  | 'boot'
  /** The first-run wizard. */
  | 'wizard'
  /** The admin web-ui. */
  | 'app';

/** Which code path is asking to navigate. */
export type NavSource =
  | 'boot-existing'
  | 'restart'
  | 'wizard-complete'
  | 'recover';

export interface ViewState {
  readonly showing: ShellView;
  /** Monotonic id of the most recent navigation intent. */
  readonly token: number;
}

export interface NavDecision {
  readonly allowed: boolean;
  /** Why not — logged, so a refused navigation is never silent. */
  readonly reason?: string;
}

const ALLOWED: NavDecision = { allowed: true };

/**
 * Sources permitted to replace an open wizard.
 *
 * `wizard-complete` is the wizard's own finish — the one legitimate
 * wizard-to-app transition. `recover` runs when the renderer died, so there is
 * no wizard left to protect; refusing there would leave the black window this
 * whole change exists to remove.
 */
const MAY_REPLACE_WIZARD: ReadonlySet<NavSource> = new Set<NavSource>([
  'wizard-complete',
  'recover',
]);

export function initialViewState(): ViewState {
  return { showing: 'boot', token: 0 };
}

/** Whether `source` may begin navigating away from what is on screen. */
export function mayStartNavigation(state: ViewState, source: NavSource): NavDecision {
  if (state.showing === 'wizard' && !MAY_REPLACE_WIZARD.has(source)) {
    return { allowed: false, reason: `${source} would overwrite the open first-run wizard` };
  }
  return ALLOWED;
}

/**
 * Record a navigation intent. The returned token must be handed back to
 * {@link mayCommitNavigation} once the async work behind it finishes.
 */
export function beginNavigation(
  state: ViewState,
  target: ShellView,
): { readonly state: ViewState; readonly token: number } {
  const token = state.token + 1;
  return { state: { showing: target, token }, token };
}

/**
 * Whether a navigation that began with `token` may still commit.
 *
 * Refuses a stale token even for sources that may replace a wizard: "the page
 * is already gone" justifies replacing the wizard, never resurrecting a view
 * that a newer intent has moved past.
 */
export function mayCommitNavigation(
  state: ViewState,
  token: number,
  source: NavSource,
): NavDecision {
  if (token !== state.token) {
    return {
      allowed: false,
      reason: `${source} navigation ${token} was superseded by ${state.token}`,
    };
  }
  return mayStartNavigation(state, source);
}

/** Settle the view after a committed navigation, keeping the current token. */
export function commitNavigation(state: ViewState, target: ShellView): ViewState {
  return { showing: target, token: state.token };
}
