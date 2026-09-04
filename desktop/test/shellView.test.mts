/**
 * Unit tests for the window-navigation arbiter (#930 / OM-58).
 *
 * The bug these pin: three independent navigation sites each ended in an
 * unconditional `loadURL`, so a boot finishing while the first-run wizard was
 * open overwrote it — the user landed on the sign-in form having never been
 * shown the data-directory step or the RECOVERY KEY step.
 *
 * Two mechanisms fix it, and each has a test below that goes red when only that
 * mechanism is reverted (verified, see the PR body):
 *   A. the wizard guard        → "refuses a background boot ..." cases
 *   B. the token staleness rule → "refuses a superseded boot ..." case
 *
 * Node's native TypeScript type stripping runs this; no test dependency.
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  abandonNavigation,
  beginNavigation,
  commitNavigation,
  initialViewState,
  mayCommitNavigation,
  mayStartNavigation,
  type NavSource,
  type ViewState,
} from '../src/shellView.ts';

/** Put the arbiter in the state it has while the wizard is on screen. */
function showingWizard(): ViewState {
  const started = beginNavigation(initialViewState(), 'wizard');
  return commitNavigation(started.state, 'wizard');
}

describe('shellView — an open wizard is not overwritten', () => {
  const BACKGROUND: readonly NavSource[] = ['boot-existing', 'restart'];

  for (const source of BACKGROUND) {
    it(`refuses a background boot from '${source}' while the wizard is open`, () => {
      const decision = mayStartNavigation(showingWizard(), source);
      assert.equal(decision.allowed, false, `'${source}' must not replace the wizard`);
      assert.match(String(decision.reason), /wizard/i);
    });
  }

  it("lets the wizard's own completion replace it", () => {
    assert.equal(mayStartNavigation(showingWizard(), 'wizard-complete').allowed, true);
  });

  it('lets a crash recovery replace it, because the page is already gone', () => {
    assert.equal(mayStartNavigation(showingWizard(), 'recover').allowed, true);
  });

  it('does not restrict anything while the app or loading screen is showing', () => {
    const booting = initialViewState();
    for (const source of BACKGROUND) {
      assert.equal(mayStartNavigation(booting, source).allowed, true);
    }
  });
});

describe('shellView — a superseded navigation does not commit', () => {
  it('refuses a superseded boot even when no wizard is involved', () => {
    // Two boots race: the tray restart begins while the startup boot is still
    // awaiting. Only the newer one may land. The wizard rule cannot mask this
    // case, which is what makes it a real regression test for the token check.
    const first = beginNavigation(initialViewState(), 'boot');
    const second = beginNavigation(first.state, 'boot');

    const stale = mayCommitNavigation(second.state, first.token, 'boot-existing');
    assert.equal(stale.allowed, false, 'the older boot must not commit');
    assert.match(String(stale.reason), /supersed/i);

    assert.equal(
      mayCommitNavigation(second.state, second.token, 'restart').allowed,
      true,
      'the newest boot must still be able to commit',
    );
  });

  it('refuses a stale recovery too, rather than resurrecting an old view', () => {
    const first = beginNavigation(initialViewState(), 'boot');
    const second = beginNavigation(first.state, 'boot');
    assert.equal(mayCommitNavigation(second.state, first.token, 'recover').allowed, false);
  });

  it('refuses a boot that began before the wizard opened', () => {
    // The end-to-end shape of the field report: a boot is in flight, the user
    // ends up in the wizard, the boot finishes. Both mechanisms cover this one.
    const boot = beginNavigation(initialViewState(), 'boot');
    const wizardOpened = commitNavigation(
      beginNavigation(boot.state, 'wizard').state,
      'wizard',
    );
    const decision = mayCommitNavigation(wizardOpened, boot.token, 'boot-existing');
    assert.equal(decision.allowed, false, 'the wizard must survive the boot finishing');
  });
});

describe('shellView — bookkeeping', () => {
  it('starts on the loading screen with a zero token', () => {
    assert.deepEqual(initialViewState(), { showing: 'boot', token: 0 });
  });

  it('gives every intent a fresh, monotonic token', () => {
    const a = beginNavigation(initialViewState(), 'boot');
    const b = beginNavigation(a.state, 'app');
    assert.equal(a.token, 1);
    assert.equal(b.token, 2);
    assert.equal(b.state.showing, 'app');
  });

  it('never mutates the state it is given', () => {
    const before = initialViewState();
    const snapshot = { ...before };
    beginNavigation(before, 'wizard');
    commitNavigation(before, 'app');
    assert.deepEqual(before, snapshot);
  });

  it('keeps the token when a navigation settles, so later commits stay valid', () => {
    const started = beginNavigation(initialViewState(), 'app');
    const settled = commitNavigation(started.state, 'app');
    assert.equal(settled.token, started.token);
  });
});

describe('shellView — abandoning a navigation that never landed', () => {
  it('refuses to release when a newer navigation owns the window', () => {
    // The dangerous direction: a late rejection must not clobber `showing` for a
    // navigation that has already moved on. The token-preservation test below
    // does not cover this — it only asserts the safe direction.
    const claimed = beginNavigation(initialViewState(), 'wizard');
    const newer = beginNavigation(claimed.state, 'app');
    const attempted = abandonNavigation(newer.state, claimed.token, 'boot');
    assert.equal(attempted.showing, 'app', 'the newer view must survive');
    assert.equal(attempted.token, newer.token);
  });

  it('releases the optimistic claim so later boots are not refused forever', () => {
    // The bug: startWizard() claims 'wizard' before the load runs. When the load
    // REJECTED, only a log line ran — leaving showing='wizard' permanently, so
    // the arbiter refused every boot-existing and restart from then on and
    // tray → Restart became a silent no-op with no way back.
    const claimed = beginNavigation(initialViewState(), 'wizard');
    assert.equal(mayStartNavigation(claimed.state, 'restart').allowed, false, 'claim is held');

    const released = abandonNavigation(claimed.state, claimed.token, 'boot');
    assert.equal(mayStartNavigation(released, 'restart').allowed, true, 'claim released');
    assert.equal(mayStartNavigation(released, 'boot-existing').allowed, true);
  });

  it('keeps the token, because the intent did happen', () => {
    const claimed = beginNavigation(initialViewState(), 'wizard');
    const released = abandonNavigation(claimed.state, claimed.token, 'boot');
    assert.equal(released.token, claimed.token);
    // An older navigation still must not land.
    assert.equal(mayCommitNavigation(released, claimed.token - 1, 'boot-existing').allowed, false);
  });

  it('does not mutate the state it is given', () => {
    const claimed = beginNavigation(initialViewState(), 'wizard');
    const snapshot = { ...claimed.state };
    abandonNavigation(claimed.state, claimed.token, 'boot');
    assert.deepEqual(claimed.state, snapshot);
  });
});
