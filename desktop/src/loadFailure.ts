/**
 * Deciding when a renderer load failure is worth recovering from (OM-57).
 *
 * The window is created with `backgroundColor: '#0b0d12'`, and the shell had
 * NO renderer error handling whatsoever — a search across `desktop/src` for
 * `did-fail-load`, `render-process-gone`, `unresponsive` or `webContents.on`
 * returned nothing, against six `loadURL`/`loadFile` calls. So when the web-ui
 * died underneath a running navigation (which is what happens when a stop
 * kills it mid-login), the window background colour was all that was left: a
 * black rectangle with no error, no spinner, and no way for the user to tell
 * whether it was their credentials, the app, or themselves.
 *
 * Recovering needs a filter, because most `did-fail-load` events here are
 * normal:
 *
 *  - **ERR_ABORTED (-3)** fires on every superseded navigation, and this shell
 *    supersedes constantly — `loading.html` is replaced by the app URL on every
 *    single boot. Treating -3 as a failure would put the app into a reload loop
 *    on the happy path.
 *  - **Subframe failures** are the web-ui's business (a broken image, a
 *    third-party iframe). Replacing the whole window over one would destroy a
 *    working page.
 *  - **The fallback page itself failing** must not trigger another attempt to
 *    load the fallback page. That is the one genuinely unrecoverable case, and
 *    it has to terminate rather than spin.
 *
 * Event field names and the -3 code come from Electron's documented
 * `did-fail-load` signature `(event, errorCode, errorDescription,
 * validatedURL, isMainFrame, ...)`; ERR_ABORTED is stable across Chromium
 * versions.
 *
 * FILTERING IS NOT ENOUGH, and the first version of this file proved it. The
 * caller can recover to two different pages, and it passed a hardcoded
 * `loading.html` as the identity to compare against — so a failing
 * `wizard.html` passed every exclusion, got reloaded, failed again, and looped
 * with no delay and no ceiling. Silently, because the only progress message on
 * that path is sent for the loading target. Hence {@link RecoveryBudget}: the
 * identity check stops the one case it can see, and the budget stops every case
 * it cannot, including a renderer that crashes repeatedly on the fallback page
 * (`render-process-gone` carries no URL to compare at all).
 */

/** Chromium's ERR_ABORTED — a navigation replaced by a newer one. */
export const ERR_ABORTED = -3;

export interface LoadFailureEvent {
  readonly errorCode: number;
  readonly isMainFrame: boolean;
  /** The URL that failed, as Electron validated it. */
  readonly validatedURL: string;
}

/**
 * Whether to abandon the current page and show the fallback.
 *
 * `fallbackURL` is compared by identity of the file part rather than in full,
 * because Electron reports a `file://` URL that will not be byte-equal to the
 * path we handed `loadFile`.
 */
export function shouldRecoverFromLoadFailure(
  event: LoadFailureEvent,
  fallbackFileName: string,
): boolean {
  if (!event.isMainFrame) return false;
  if (event.errorCode === ERR_ABORTED) return false;
  // The fallback failing to load is unrecoverable; another attempt would spin.
  if (event.validatedURL.includes(fallbackFileName)) return false;
  return true;
}

/**
 * How many times the shell may replace a dead renderer before it stops trying.
 *
 * Three is enough to ride out a transient failure and small enough that a
 * genuinely broken install reaches a terminal, explained state in under a
 * second rather than spinning.
 */
export const MAX_RECOVERY_ATTEMPTS = 3;

/**
 * The recovery budget.
 *
 * Counted per target page: recovering the wizard twice and then the loading
 * screen once is three distinct problems, not one runaway loop, and collapsing
 * them into a single counter would refuse a legitimate second recovery.
 */
export interface RecoveryBudget {
  readonly attempts: number;
  /** The page those attempts were spent on, or null before the first. */
  readonly page: string | null;
}

export function initialRecoveryBudget(): RecoveryBudget {
  return { attempts: 0, page: null };
}

export interface RecoveryAttempt {
  readonly budget: RecoveryBudget;
  /** False once the budget for this page is spent — stop, do not reload. */
  readonly allowed: boolean;
}

/** Claim one recovery attempt for `page`. */
export function nextRecoveryAttempt(
  budget: RecoveryBudget,
  page: string,
  maxAttempts: number = MAX_RECOVERY_ATTEMPTS,
): RecoveryAttempt {
  const attempts = budget.page === page ? budget.attempts + 1 : 1;
  return {
    budget: { attempts, page },
    allowed: attempts <= maxAttempts,
  };
}

/**
 * Reset the budget after any successful load.
 *
 * Driven by `did-finish-load`, which fires for the app URL on every ordinary
 * boot too — and that is correct: something rendered, so the shell is by
 * definition not looping any more.
 */
export function clearRecoveryBudget(): RecoveryBudget {
  return initialRecoveryBudget();
}
