/**
 * "No update" is not always "up to date".
 *
 * electron-updater withholds an update whose feed declares a
 * `minimumSystemVersion` above `os.release()` and then emits
 * `update-not-available` with the FEED's version. The macOS feed carries such a
 * floor (22.0.0, macOS 13, for Electron 44). The updater read that event as
 * "You're already on the latest version" and showed the feed's version as the
 * current one, so a macOS 11/12 install was told it was current while it stayed
 * on a runtime without security fixes.
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { app } from 'electron';

import {
  compareVersions,
  decideNoUpdate,
  holdBackOf,
  noUpdateOutcome,
  type HoldBackNotice,
  type NoUpdateInput,
} from '../src/updateHoldBack.ts';

// The electron-updater every desktop build ships, and the semver it resolves:
// the decision here has to agree with theirs, not with a restatement of it.
const require = createRequire(import.meta.url);
const { AppUpdater } = require('electron-updater/out/AppUpdater.js') as {
  AppUpdater: { prototype: { checkIfUpdateSupported(info: unknown): boolean } };
};
const updaterSemver = createRequire(require.resolve('electron-updater'))('semver') as {
  compare(a: string, b: string): number;
};

/** electron-updater's own verdict: would this OS be offered `floor`'s update? */
function updaterOffers(osRelease: string, floor: string): boolean {
  const release = mock.method(os, 'release', () => osRelease);
  try {
    const quiet = { info() {}, warn() {} };
    return AppUpdater.prototype.checkIfUpdateSupported.call(
      { _logger: quiet },
      { version: '0.151.0', minimumSystemVersion: floor },
    );
  } finally {
    release.mock.restore();
  }
}

const FEED = { version: '0.151.0', minimumSystemVersion: '22.0.0' } as const;
const MACOS_12 = '21.6.0';
const MACOS_13 = '22.1.0';
const NOTHING_SAID: HoldBackNotice = { noticedFloor: null };

function input(overrides: Partial<NoUpdateInput>): NoUpdateInput {
  return {
    info: FEED,
    currentVersion: '0.150.2',
    osRelease: MACOS_12,
    platform: 'darwin',
    manual: false,
    notice: NOTHING_SAID,
    ...overrides,
  };
}

test('a macOS 12 install behind the floor is held back, and told which macOS it needs', () => {
  assert.deepEqual(holdBackOf(FEED, '0.150.2', MACOS_12, 'darwin'), {
    version: '0.151.0',
    minimumSystemVersion: '22.0.0',
    macos: '13',
  });
  assert.equal(holdBackOf(FEED, '0.150.2', '20.6.0', 'darwin')?.macos, '13');
});

test('a manual check on a held-back Mac does not claim it is current', () => {
  const { outcome } = noUpdateOutcome(input({ manual: true }));
  assert.ok(outcome.kind === 'heldBack', `expected a hold-back, got ${outcome.kind}`);
  // The version it runs, not the release it cannot install.
  assert.equal(outcome.current, '0.150.2');
  assert.equal(outcome.holdBack.version, '0.151.0');
});

test('an up-to-date answer names the installed version, never the feed\'s', () => {
  // A feed version older than ours (a release pulled back to draft) is "no
  // update" too; the dialog must still say what this computer runs.
  const { outcome } = noUpdateOutcome(
    input({ manual: true, currentVersion: '0.152.0', osRelease: MACOS_13 }),
  );
  assert.deepEqual(outcome, { kind: 'upToDate', current: '0.152.0' });
});

test('a Mac at or above the floor is not held back', () => {
  assert.equal(holdBackOf(FEED, '0.150.2', MACOS_13, 'darwin'), null);
  assert.equal(holdBackOf(FEED, '0.150.2', '22.0.0', 'darwin'), null);
  assert.equal(holdBackOf(FEED, '0.150.2', '25.5.0', 'darwin'), null);
});

test('the floor is only consulted for a newer release, as electron-updater does', () => {
  // Equal versions are "current" before electron-updater looks at the floor.
  assert.equal(holdBackOf(FEED, '0.151.0', MACOS_12, 'darwin'), null);
  // An older feed version was never an update for this computer.
  assert.equal(holdBackOf(FEED, '0.152.0', MACOS_12, 'darwin'), null);
  assert.equal(holdBackOf({ version: '0.151.0' }, '0.150.2', MACOS_12, 'darwin'), null);
});

test('a floor electron-updater cannot parse holds nothing back', () => {
  // "13.0" is the product version; electron-updater's semver throws on it and
  // lets every Mac update, so there is no hold-back to report.
  assert.equal(
    holdBackOf({ version: '0.151.0', minimumSystemVersion: '13.0' }, '0.150.2', MACOS_12, 'darwin'),
    null,
  );
});

test('names a macOS release only for a whole-major floor it knows', () => {
  const at = (floor: string, platform: NodeJS.Platform = 'darwin') =>
    holdBackOf({ version: '0.151.0', minimumSystemVersion: floor }, '0.150.2', '19.6.0', platform);
  assert.equal(at('20.0.0')?.macos, '11');
  assert.equal(at('24.0.0')?.macos, '15');
  assert.equal(at('25.0.0')?.macos, '26');
  // Held back, but without a release name the dialog falls back to generic text.
  assert.equal(at('22.4.0')?.macos, null);
  assert.equal(at('26.0.0')?.macos, null);
  assert.equal(at('22.0.0', 'win32')?.macos, null);
});

test('agrees with electron-updater on which operating systems are held back', () => {
  const releases = ['19.6.0', '20.6.0', '21.6.0', '21.99.99', '22.0.0', '22.1.0', '25.5.0', '22.1', 'garbage'];
  const floors = ['22.0.0', '23.0.0', '22.1.0', '13.0', '22.0.0-beta.1'];
  for (const release of releases) {
    for (const floor of floors) {
      const heldBack = holdBackOf(
        { version: '0.151.0', minimumSystemVersion: floor },
        '0.150.2',
        release,
        'darwin',
      );
      assert.equal(
        heldBack !== null,
        !updaterOffers(release, floor),
        `os.release() ${release} against floor ${floor}`,
      );
    }
  }
});

test('orders versions exactly as the semver electron-updater uses', () => {
  const ladder = [
    '1.0.0-alpha',
    '1.0.0-alpha.1',
    '1.0.0-alpha.beta',
    '1.0.0-beta',
    '1.0.0-beta.2',
    '1.0.0-beta.11',
    '1.0.0-rc.1',
    '1.0.0',
    '1.0.1',
    '1.2.0',
    '2.0.0',
    '10.0.0',
  ];
  for (const a of ladder) {
    for (const b of ladder) {
      assert.equal(compareVersions(a, b), updaterSemver.compare(a, b), `${a} vs ${b}`);
    }
  }
  assert.equal(compareVersions('v22.1.0', '22.1.0+build.7'), 0);
  for (const invalid of ['13.0', '01.0.0', '22.1', '', 'x.y.z', `1.0.0-${'a'.repeat(300)}`]) {
    assert.equal(compareVersions(invalid, '1.0.0'), null, invalid);
    assert.throws(() => updaterSemver.compare(invalid, '1.0.0'), TypeError, invalid);
  }
});

test('the startup check names a hold-back once per floor', () => {
  const first = noUpdateOutcome(input({}));
  assert.equal(first.outcome.kind, 'heldBack');
  assert.deepEqual(first.notice, { noticedFloor: '22.0.0' });

  // The next start, and every release after it behind the same floor.
  const second = noUpdateOutcome(input({ notice: first.notice }));
  assert.deepEqual(second.outcome, { kind: 'silent' });
  const later = noUpdateOutcome(
    input({ info: { version: '0.155.0', minimumSystemVersion: '22.0.0' }, notice: first.notice }),
  );
  assert.deepEqual(later.outcome, { kind: 'silent' });

  // A higher floor is new news.
  const raised = noUpdateOutcome(
    input({
      info: { version: '0.170.0', minimumSystemVersion: '23.0.0' },
      osRelease: MACOS_13,
      notice: first.notice,
    }),
  );
  assert.equal(raised.outcome.kind, 'heldBack');
  assert.deepEqual(raised.notice, { noticedFloor: '23.0.0' });
});

test('a manual check always answers, and counts as having told the user', () => {
  const told = { noticedFloor: '22.0.0' };
  assert.equal(noUpdateOutcome(input({ manual: true, notice: told })).outcome.kind, 'heldBack');
  const fresh = noUpdateOutcome(input({ manual: true }));
  assert.deepEqual(fresh.notice, told);
  assert.deepEqual(noUpdateOutcome(input({ notice: fresh.notice })).outcome, { kind: 'silent' });
});

test('the startup check stays silent when the app is current', () => {
  const current = noUpdateOutcome(input({ currentVersion: '0.151.0' }));
  assert.deepEqual(current.outcome, { kind: 'silent' });
  assert.deepEqual(current.notice, NOTHING_SAID);
});

test('remembers the notice across starts in userData', () => {
  const file = path.join(app.getPath('userData'), 'updater-hold-back.json');
  fs.rmSync(file, { force: true });
  const release = mock.method(os, 'release', () => MACOS_12);
  try {
    // The fake app reports 0.0.0-test, so any released version is newer.
    assert.equal(decideNoUpdate(FEED, false).kind, 'heldBack');
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { noticedFloor: '22.0.0' });
    assert.equal(decideNoUpdate(FEED, false).kind, 'silent');
    assert.equal(decideNoUpdate(FEED, true).kind, 'heldBack');

    // An unreadable record means nothing was said, so the notice comes again.
    fs.writeFileSync(file, 'not json', 'utf8');
    assert.equal(decideNoUpdate(FEED, false).kind, 'heldBack');
  } finally {
    release.mock.restore();
    fs.rmSync(file, { force: true });
  }
});
