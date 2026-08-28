/**
 * Unit tests for renderer load-failure filtering (#929 / OM-57).
 *
 * The bug these pin: the window had NO renderer error handling, so when the
 * web-ui died under a running navigation the user was left with
 * `backgroundColor: '#0b0d12'` — a black rectangle with no explanation.
 *
 * Recovering needs a filter, and each exclusion below prevents a concrete
 * regression: ERR_ABORTED fires on the happy path (loading.html is superseded by
 * the app URL on EVERY boot), subframe failures belong to the page, and the
 * fallback failing must terminate rather than spin.
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  ERR_ABORTED,
  MAX_RECOVERY_ATTEMPTS,
  clearRecoveryBudget,
  initialRecoveryBudget,
  nextRecoveryAttempt,
  shouldRecoverFromLoadFailure,
  type LoadFailureEvent,
} from '../src/loadFailure.ts';

const LOADING_PAGE = 'loading.html';
const WIZARD_PAGE = 'wizard.html';

function event(over: Partial<LoadFailureEvent> = {}): LoadFailureEvent {
  return {
    errorCode: -105,
    isMainFrame: true,
    validatedURL: 'http://127.0.0.1:7777/admin',
    ...over,
  };
}

describe('shouldRecoverFromLoadFailure', () => {
  it('recovers from a real main-frame failure of the app URL', () => {
    assert.equal(shouldRecoverFromLoadFailure(event(), LOADING_PAGE), true);
  });

  it('ignores ERR_ABORTED, which fires on every superseded navigation', () => {
    // This is the happy path: loading.html → app URL aborts the first load.
    // Recovering here would put the shell into a reload loop on a good boot.
    assert.equal(
      shouldRecoverFromLoadFailure(event({ errorCode: ERR_ABORTED }), LOADING_PAGE),
      false,
    );
  });

  it('ignores subframe failures, which belong to the page', () => {
    assert.equal(shouldRecoverFromLoadFailure(event({ isMainFrame: false }), LOADING_PAGE), false);
  });

  it('does not try to recover the fallback page with itself', () => {
    const failed = event({
      validatedURL: 'file:///Applications/omadia.app/Contents/dist/renderer/loading.html',
    });
    assert.equal(shouldRecoverFromLoadFailure(failed, LOADING_PAGE), false);
  });

  it('recovers from a failed wizard load when the fallback is a different page', () => {
    const failed = event({ validatedURL: 'file:///…/dist/renderer/wizard.html' });
    assert.equal(shouldRecoverFromLoadFailure(failed, LOADING_PAGE), true);
  });

  it('refuses to recover the wizard WITH the wizard — the loop found in review', () => {
    // The blocker: `recoverRenderer` targets wizard.html whenever the wizard is
    // showing, but the caller passed a hardcoded `loading.html` as the identity.
    // So a failing wizard passed every exclusion, was reloaded, failed again,
    // and looped — silently, because the progress message only fires for the
    // loading target. An earlier version of this suite ASSERTED that behaviour.
    const failed = event({ validatedURL: 'file:///…/dist/renderer/wizard.html' });
    assert.equal(shouldRecoverFromLoadFailure(failed, WIZARD_PAGE), false);
  });

  it('pins ERR_ABORTED to Chromium’s documented -3', () => {
    assert.equal(ERR_ABORTED, -3);
  });
});

describe('recovery budget — the guard for everything the filter cannot see', () => {
  it('starts empty', () => {
    assert.deepEqual(initialRecoveryBudget(), { attempts: 0, page: null });
  });

  it(`allows exactly ${MAX_RECOVERY_ATTEMPTS} attempts on one page, then stops`, () => {
    let budget = initialRecoveryBudget();
    for (let i = 1; i <= MAX_RECOVERY_ATTEMPTS; i += 1) {
      const attempt = nextRecoveryAttempt(budget, WIZARD_PAGE);
      budget = attempt.budget;
      assert.equal(attempt.allowed, true, `attempt ${i} should be allowed`);
    }
    const exhausted = nextRecoveryAttempt(budget, WIZARD_PAGE);
    assert.equal(exhausted.allowed, false, 'the budget must run out');
  });

  it('never allows an unbounded run, whatever the ceiling', () => {
    // The property that actually matters: no infinite loop.
    let budget = initialRecoveryBudget();
    let allowedCount = 0;
    for (let i = 0; i < 500; i += 1) {
      const attempt = nextRecoveryAttempt(budget, WIZARD_PAGE);
      budget = attempt.budget;
      if (attempt.allowed) allowedCount += 1;
    }
    assert.equal(allowedCount, MAX_RECOVERY_ATTEMPTS);
  });

  it('counts per page, so a second distinct failure is not starved', () => {
    let budget = initialRecoveryBudget();
    for (let i = 0; i < MAX_RECOVERY_ATTEMPTS; i += 1) {
      budget = nextRecoveryAttempt(budget, WIZARD_PAGE).budget;
    }
    assert.equal(nextRecoveryAttempt(budget, WIZARD_PAGE).allowed, false);
    // Switching target resets: recovering the wizard twice and then the loading
    // screen once is three problems, not one runaway loop.
    const other = nextRecoveryAttempt(budget, LOADING_PAGE);
    assert.equal(other.allowed, true);
    assert.equal(other.budget.attempts, 1);
    assert.equal(other.budget.page, LOADING_PAGE);
  });

  it('is cleared by any successful load', () => {
    let budget = initialRecoveryBudget();
    for (let i = 0; i < MAX_RECOVERY_ATTEMPTS; i += 1) {
      budget = nextRecoveryAttempt(budget, WIZARD_PAGE).budget;
    }
    assert.equal(nextRecoveryAttempt(budget, WIZARD_PAGE).allowed, false);
    budget = clearRecoveryBudget();
    assert.equal(nextRecoveryAttempt(budget, WIZARD_PAGE).allowed, true);
  });

  it('does not mutate the budget it is given', () => {
    const before = initialRecoveryBudget();
    const snapshot = { ...before };
    nextRecoveryAttempt(before, WIZARD_PAGE);
    assert.deepEqual(before, snapshot);
  });
});
