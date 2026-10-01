// Tests for the macOS update-feed merge.
//
// This script decides what every installed macOS app downloads on update, and a
// silently wrong merge would break updates for all users at once — so the guard
// rails matter more than the happy path and are covered individually.
//
// Run: node --test desktop/scripts/
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { createRequire } from 'node:module';
import {
  parseFeed,
  serializeFeed,
  mergeFeeds,
  darwinFloorFor,
  checkAppMinimum,
  MACOS_MINIMUM,
  MINIMUM_SYSTEM_VERSION,
} from './merge-mac-update-feed.mjs';

// What an installed app does with the published feed, taken from the
// electron-updater it ships rather than restated here: its YAML parse, and the
// OS gate that compares `minimumSystemVersion` with `os.release()`
// (AppUpdater.checkIfUpdateSupported, electron-updater 6.8.9 — the version
// every released desktop build has carried).
const require = createRequire(import.meta.url);
const { parseUpdateInfo } = require('electron-updater/out/providers/Provider.js');
const { AppUpdater } = require('electron-updater/out/AppUpdater.js');

/** Would a Mac reporting `darwinRelease` from os.release() take this feed's update? */
function offeredOn(feedText, darwinRelease) {
  const info = parseUpdateInfo(feedText, 'latest-mac.yml', 'https://example.invalid/latest-mac.yml');
  const release = mock.method(os, 'release', () => darwinRelease);
  try {
    const quiet = { info() {}, warn() {} };
    return AppUpdater.prototype.checkIfUpdateSupported.call({ _logger: quiet }, info);
  } finally {
    release.mock.restore();
  }
}

// Verbatim from the v0.57.1 release, so the parser is pinned to real
// electron-builder output rather than to an idealised sample.
const ARM64 = `version: 0.1.0
files:
  - url: omadia-0.1.0-arm64-mac.zip
    sha512: bPQD94yVv5wGIpvW5zqqZT6o9hzIlWaRsMqlAZYuzGgbtcgOBuR8txufO12TafkdKt9YVaHzv3aoNylOUjgu+w==
    size: 277721721
  - url: omadia-0.1.0-arm64.dmg
    sha512: +lNAsNIlNZlFtiYNzo8eEbf+1STpusNy8MXX+tMfZck4Rxd5s8bnEKRnrbrQVDCJ1rXb6gSMsIjo6VU/aZyY1Q==
    size: 283467184
path: omadia-0.1.0-arm64-mac.zip
sha512: bPQD94yVv5wGIpvW5zqqZT6o9hzIlWaRsMqlAZYuzGgbtcgOBuR8txufO12TafkdKt9YVaHzv3aoNylOUjgu+w==
releaseDate: '2026-07-31T09:43:18.403Z'
`;

const X64 = ARM64.replaceAll('arm64', 'x64');

test('parses real electron-builder output', () => {
  const feed = parseFeed(ARM64, 'arm64');
  assert.equal(feed.scalars.version, '0.1.0');
  assert.equal(feed.files.length, 2);
  assert.equal(feed.files[0].url, 'omadia-0.1.0-arm64-mac.zip');
  assert.equal(feed.files[0].size, '277721721');
  // releaseDate is the only quoted scalar; the quotes must not survive parsing.
  assert.equal(feed.scalars.releaseDate, '2026-07-31T09:43:18.403Z');
});

test('round-trips without changing the document', () => {
  assert.equal(serializeFeed(parseFeed(ARM64, 'arm64')), ARM64);
});

test('merges both architectures, arm64 first', () => {
  const merged = mergeFeeds(parseFeed(ARM64, 'a'), parseFeed(X64, 'b'));
  assert.deepEqual(
    merged.files.map((f) => f.url),
    [
      'omadia-0.1.0-arm64-mac.zip',
      'omadia-0.1.0-arm64.dmg',
      'omadia-0.1.0-x64-mac.zip',
      'omadia-0.1.0-x64.dmg',
    ],
  );
  // MacUpdater matches on "arm64" appearing in the URL — assert the property it
  // actually relies on, not merely the count.
  assert.ok(merged.files.some((f) => f.url.includes('arm64')));
  assert.ok(merged.files.some((f) => !f.url.includes('arm64')));
});

test('keeps the primary feed legacy path/sha512 for pre-arch-aware updaters', () => {
  const merged = mergeFeeds(parseFeed(ARM64, 'a'), parseFeed(X64, 'b'));
  assert.equal(merged.scalars.path, 'omadia-0.1.0-arm64-mac.zip');
});

test('the merged feed keeps Macs the runtime cannot start on at the build they have', () => {
  // Electron 44 needs macOS 13. Without a floor in the feed, a macOS 11/12
  // install downloads and installs the update, and the app no longer starts.
  const merged = serializeFeed(mergeFeeds(parseFeed(ARM64, 'a'), parseFeed(X64, 'b')));
  // os.release() reports the Darwin kernel: macOS 11 is 20.x, macOS 12 is 21.x.
  assert.equal(offeredOn(merged, '20.6.0'), false, 'macOS 11 must not be offered the update');
  assert.equal(offeredOn(merged, '21.6.0'), false, 'macOS 12 must not be offered the update');
  // macOS 13 shipped as Darwin 22.1.0; macOS 26 is Darwin 25.
  assert.equal(offeredOn(merged, '22.1.0'), true, 'macOS 13 must still update');
  assert.equal(offeredOn(merged, '25.5.0'), true, 'macOS 26 must still update');
});

test('writes the floor as the Darwin version electron-updater compares, after releaseDate', () => {
  const merged = serializeFeed(mergeFeeds(parseFeed(ARM64, 'a'), parseFeed(X64, 'b')));
  assert.equal(MACOS_MINIMUM, '13.0');
  assert.equal(MINIMUM_SYSTEM_VERSION, '22.0.0');
  assert.match(merged, /\nreleaseDate: '[^']+'\nminimumSystemVersion: 22\.0\.0\n$/);
});

test('the macOS product version is not a usable floor', () => {
  // "13.0" is what Info.plist says, but electron-updater's semver comparison
  // throws on it, logs a warning and lets every Mac update: no floor at all.
  const productForm = ARM64 + 'minimumSystemVersion: 13.0\n';
  assert.equal(offeredOn(productForm, '21.6.0'), true);
});

test('maps each macOS major onto the Darwin kernel os.release() reports', () => {
  assert.equal(darwinFloorFor('11.0'), '20.0.0');
  assert.equal(darwinFloorFor('12.0'), '21.0.0');
  assert.equal(darwinFloorFor('13'), '22.0.0');
  assert.equal(darwinFloorFor('15.0.0'), '24.0.0');
  assert.equal(darwinFloorFor('26.0'), '25.0.0');
  // macOS 16–25 never existed; a minor-level minimum has no Darwin major of its own.
  assert.throws(() => darwinFloorFor('16.0'), /no Darwin version known for macOS "16.0"/);
  assert.throws(() => darwinFloorFor('13.3'), /no Darwin version known/);
  assert.throws(() => darwinFloorFor(''), /no Darwin version known/);
});

test('accepts a packaged app whose minimum is the floor the feed declares', () => {
  assert.doesNotThrow(() => checkAppMinimum('13.0'));
});

test('fails the build when the packaged app needs a different macOS than the feed says', () => {
  // A runtime that needs macOS 14 would be offered to macOS 13 and not start.
  assert.throws(() => checkAppMinimum('14.0'), /LSMinimumSystemVersion 14\.0.*minimumSystemVersion 22\.0\.0/s);
  // One that still runs on macOS 12 would keep those Macs off it for nothing.
  assert.throws(() => checkAppMinimum('12.0'), /Set MACOS_MINIMUM/);
});

test('round-trips a feed that already carries the floor', () => {
  const withFloor = ARM64 + 'minimumSystemVersion: 22.0.0\n';
  assert.equal(parseFeed(withFloor, 'f').scalars.minimumSystemVersion, '22.0.0');
  assert.equal(serializeFeed(parseFeed(withFloor, 'f')), withFloor);
});

test('refuses to merge an input feed whose floor disagrees', () => {
  const other = X64 + 'minimumSystemVersion: 23.0.0\n';
  assert.throws(() => mergeFeeds(parseFeed(ARM64, 'a'), parseFeed(other, 'b')), /declares minimumSystemVersion 23\.0\.0/);
});

test('serialized merge stays parseable', () => {
  const merged = mergeFeeds(parseFeed(ARM64, 'a'), parseFeed(X64, 'b'));
  assert.equal(parseFeed(serializeFeed(merged), 'merged').files.length, 4);
});

test('rejects a single-architecture merge', () => {
  // The dangerous case: two arm64 feeds merge "successfully" into a feed that
  // leaves every Intel user unable to update.
  assert.throws(() => mergeFeeds(parseFeed(ARM64, 'a'), parseFeed(ARM64, 'b')), /only one architecture/);
});

test('rejects mismatched versions', () => {
  const other = X64.replace('version: 0.1.0', 'version: 0.2.0');
  assert.throws(() => mergeFeeds(parseFeed(ARM64, 'a'), parseFeed(other, 'b')), /version mismatch/);
});

test('deduplicates an artifact listed in both feeds', () => {
  const merged = mergeFeeds(parseFeed(ARM64, 'a'), parseFeed(ARM64 + X64.split('\n').slice(1).join('\n'), 'b'));
  const urls = merged.files.map((f) => f.url);
  assert.equal(new Set(urls).size, urls.length);
});

test('rejects an unknown top-level key rather than dropping it', () => {
  assert.throws(() => parseFeed('version: 1\nbogus: x\nfiles:\n  - url: a-arm64.z\n    sha512: s\n    size: 1\n', 'f'), /unexpected top-level key "bogus"/);
});

test('rejects an unparseable line', () => {
  assert.throws(() => parseFeed('version: 1\nfiles:\n  - url: a-arm64.z\n    sha512: s\n    size: 1\n!!!garbage\n', 'f'), /unparseable line/);
});

test('rejects a file entry missing a field', () => {
  assert.throws(() => parseFeed('version: 1\nfiles:\n  - url: a-arm64.z\n    size: 1\n', 'f'), /missing "sha512"/);
});

test('rejects a feed with no files', () => {
  assert.throws(() => parseFeed('version: 1\nfiles:\n', 'f'), /no files listed/);
});
