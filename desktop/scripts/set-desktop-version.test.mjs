// Tests for the desktop package-version rewrite.
//
// This script decides what version the shipped desktop app claims to be, so the
// guard rails matter more than the happy path: one bad parse or one sloppy JSON
// rewrite would label the installer, the app metadata, and the updater wrong.
//
// Run: node --test desktop/scripts/
import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveVersion, setPackageVersion } from './set-desktop-version.mjs';

test('strips one leading v from a release tag', () => {
  assert.equal(deriveVersion('v1.2.3'), '1.2.3');
});

test('passes a bare semver through unchanged', () => {
  assert.equal(deriveVersion('1.2.3'), '1.2.3');
});

test('accepts prerelease semver tags', () => {
  assert.equal(deriveVersion('v1.2.3-beta.1'), '1.2.3-beta.1');
});

test('rejects incomplete versions', () => {
  assert.throws(
    () => deriveVersion('v1.2'),
    /Invalid version tag: "v1.2" — expected vX.Y.Z or X.Y.Z/,
  );
});

test('rejects non-semver tags', () => {
  assert.throws(
    () => deriveVersion('latest'),
    /Invalid version tag: "latest" — expected vX.Y.Z or X.Y.Z/,
  );
});

test('rejects the empty string', () => {
  assert.throws(
    () => deriveVersion(''),
    /Invalid version tag: "" — expected vX.Y.Z or X.Y.Z/,
  );
});

test('rejects a second leading v rather than stripping twice', () => {
  assert.throws(
    () => deriveVersion('vv1.2.3'),
    /Invalid version tag: "vv1.2.3" — expected vX.Y.Z or X.Y.Z/,
  );
});

test('rejects build metadata', () => {
  assert.throws(
    () => deriveVersion('v1.2.3+build.4'),
    /Invalid version tag: "v1.2.3\+build.4" — expected vX.Y.Z or X.Y.Z/,
  );
});

test('rejects non-string input with the same clear error', () => {
  assert.throws(
    () => deriveVersion(undefined),
    /Invalid version tag: "undefined" — expected vX.Y.Z or X.Y.Z/,
  );
});

test('rewrites package.json with repo-stable formatting', () => {
  const before = `{
  "name": "omadia-desktop",
  "version": "0.1.0",
  "private": true
}
`;
  assert.equal(
    setPackageVersion(before, '1.2.3'),
    `{
  "name": "omadia-desktop",
  "version": "1.2.3",
  "private": true
}
`,
  );
});
