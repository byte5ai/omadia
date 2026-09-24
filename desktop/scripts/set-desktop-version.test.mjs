// Tests for the desktop package-version rewrite.
//
// This script decides what version the shipped desktop app claims to be, so the
// guard rails matter more than the happy path: one bad parse or one sloppy JSON
// rewrite would label the installer, the app metadata, and the updater wrong.
//
// Run: npm test --workspace-root=false  (from desktop/), or
//      node --test desktop/scripts/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveVersion, setPackageVersion } from './set-desktop-version.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

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

/**
 * The CLI half — which is where this script actually failed.
 *
 * Every test above covers `deriveVersion` / `setPackageVersion`, and all of
 * them passed while the shipped Windows installer was named
 * `omadia.Setup.0.1.0.exe`: the entry-point guard compared `import.meta.url`
 * against a `file://` URL concatenated from `process.argv[1]`, which on Windows
 * is a backslash path and never matches. `isMain` was false, the script exited
 * 0 having written nothing, and CI's "Set desktop app version" step reported
 * success. Pure-function coverage cannot see that; only running the thing can.
 *
 * The reproduction below is deliberately platform-portable. A path containing a
 * SPACE breaks the old guard on macOS and Linux too, for exactly the same
 * reason Windows breaks it: `import.meta.url` percent-encodes (`probe dir` →
 * `probe%20dir`) what `process.argv[1]` spells literally. So this test fails on
 * every runner if the guard regresses — it does not need a Windows machine to
 * catch a Windows bug.
 */
function runInCopiedTree(dirName, args) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omadia-setver-'));
  const scriptDir = path.join(root, dirName, 'scripts');
  fs.mkdirSync(scriptDir, { recursive: true });
  for (const file of ['set-desktop-version.mjs', 'isEntryPoint.mjs']) {
    fs.copyFileSync(path.join(here, file), path.join(scriptDir, file));
  }
  // The script rewrites `../package.json` relative to its own location.
  const pkgPath = path.join(root, dirName, 'package.json');
  fs.writeFileSync(
    pkgPath,
    '{\n  "name": "omadia-desktop",\n  "version": "0.1.0",\n  "private": true\n}\n',
  );
  const stdout = execFileSync(
    process.execPath,
    [path.join(scriptDir, 'set-desktop-version.mjs'), ...args],
    { encoding: 'utf8' },
  );
  const version = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version;
  fs.rmSync(root, { recursive: true, force: true });
  return { stdout, version };
}

test('run as a CLI, it actually writes the version', () => {
  const { stdout, version } = runInCopiedTree('desktop', ['v9.8.7']);
  assert.equal(version, '9.8.7');
  assert.match(stdout, /desktop\/package\.json version -> 9\.8\.7/);
});

test('writes the version even from a path that percent-encodes — the Windows failure, reproduced portably', () => {
  const { version } = runInCopiedTree('desktop dir', ['v9.8.7']);
  assert.equal(
    version,
    '9.8.7',
    'the entry-point guard must survive a path the URL form encodes differently ' +
      '(a space here, backslashes on Windows) — otherwise the script is a silent no-op',
  );
});

test('run as a CLI with no tag, it fails loudly instead of no-opping', () => {
  assert.throws(
    () => runInCopiedTree('desktop', []),
    (err) => {
      assert.equal(err.status, 1);
      assert.match(String(err.stderr), /usage: set-desktop-version\.mjs <tag>/);
      return true;
    },
  );
});

test('run as a CLI with a bad tag, it fails instead of shipping a mislabeled build', () => {
  assert.throws(
    () => runInCopiedTree('desktop', ['latest']),
    (err) => {
      assert.equal(err.status, 1);
      assert.match(String(err.stderr), /Invalid version tag: "latest"/);
      return true;
    },
  );
});

test('imported rather than executed, it writes nothing', () => {
  // The other half of the guard: `npm test` imports this module, and an
  // import that rewrote package.json would corrupt the working tree.
  const before = fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8');
  assert.equal(JSON.parse(before).version, '0.1.0');
});
