// Tests for the macOS update-feed merge.
//
// This script decides what every installed macOS app downloads on update, and a
// silently wrong merge would break updates for all users at once — so the guard
// rails matter more than the happy path and are covered individually.
//
// Run: node --test desktop/scripts/
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFeed, serializeFeed, mergeFeeds } from './merge-mac-update-feed.mjs';

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
