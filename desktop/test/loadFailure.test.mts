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
  shouldRecoverFromLoadFailure,
  type LoadFailureEvent,
} from '../src/loadFailure.ts';

const LOADING_PAGE = 'loading.html';

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

  it('recovers from a failed wizard load, which is not the fallback', () => {
    const failed = event({ validatedURL: 'file:///…/dist/renderer/wizard.html' });
    assert.equal(shouldRecoverFromLoadFailure(failed, LOADING_PAGE), true);
  });

  it('pins ERR_ABORTED to Chromium’s documented -3', () => {
    assert.equal(ERR_ABORTED, -3);
  });
});
