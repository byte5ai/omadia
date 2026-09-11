// Tests for the staged-tree mode normalisation (OM-86, beta round 5).
//
// One 0444 file out of 25,895 was enough to make every macOS self-update fail
// in Squirrel's quarantine strip. These tests pin the two halves of the guard:
// the pass that adds the owner-write bit, and the scan that must find nothing
// afterwards. Symlinks are deliberately left alone — chmod follows them, and
// the Postgres engine's relative dylib chain must survive staging untouched.
//
// Run: node --test desktop/scripts/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ensureOwnerWritable, findReadOnlyEntries } from './normalize-file-modes.mjs';

const OWNER_WRITE = 0o200;

function makeTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omadia-modes-'));
  const libDir = path.join(root, 'omadia-pg', 'lib', 'postgresql');
  fs.mkdirSync(libDir, { recursive: true });
  const dylib = path.join(libDir, 'vector.dylib');
  fs.writeFileSync(dylib, 'not really a dylib');
  fs.chmodSync(dylib, 0o444);
  const normal = path.join(root, 'omadia-pg', 'lib', 'libpq.dylib');
  fs.writeFileSync(normal, 'writable');
  fs.chmodSync(normal, 0o644);
  return { root, dylib, normal, libDir };
}

test('finds the one read-only file the release archive shipped', () => {
  const { root } = makeTree();
  assert.deepEqual(findReadOnlyEntries(root), {
    offenders: [path.join('omadia-pg', 'lib', 'postgresql', 'vector.dylib')],
    unreadable: [],
  });
});

test('adds the owner-write bit and keeps every other permission bit', () => {
  const { root, dylib, normal } = makeTree();
  const { fixed } = ensureOwnerWritable(root);

  assert.deepEqual(fixed, [path.join('omadia-pg', 'lib', 'postgresql', 'vector.dylib')]);
  assert.equal(fs.statSync(dylib).mode & 0o777, 0o644, 'r--r--r-- becomes rw-r--r--');
  assert.equal(fs.statSync(normal).mode & 0o777, 0o644, 'already-writable files are untouched');
  assert.deepEqual(
    findReadOnlyEntries(root),
    { offenders: [], unreadable: [] },
    'the scan finds nothing afterwards',
  );
});

test('fixes a read-only directory as well as a file', () => {
  const { root } = makeTree();
  const dir = path.join(root, 'share');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'x');
  fs.chmodSync(dir, 0o555);

  const { fixed } = ensureOwnerWritable(root);
  assert.ok(fixed.includes('share'), `expected 'share' in ${JSON.stringify(fixed)}`);
  assert.ok((fs.statSync(dir).mode & OWNER_WRITE) !== 0);
});

test('never follows or touches a symlink', { skip: process.platform === 'win32' }, () => {
  const { root, libDir } = makeTree();
  const target = path.join(libDir, 'libicudata.68.2.dylib');
  fs.writeFileSync(target, 'icu');
  fs.chmodSync(target, 0o444);
  const link = path.join(libDir, 'libicudata.68.dylib');
  fs.symlinkSync('libicudata.68.2.dylib', link);

  const { fixed } = ensureOwnerWritable(root);
  assert.ok(fs.lstatSync(link).isSymbolicLink(), 'the link survives');
  assert.ok(!fixed.includes(path.relative(root, link)), 'the link is not reported');
  assert.ok(fixed.includes(path.relative(root, target)), 'the target is fixed via its own entry');
});

// Cato-Audit Runde 5 / OM-86 follow-up — an unreadable directory used to make
// both walks return an EMPTY list, which stage-runtime.mjs reads as "clean".
// A guard that reports success over a subtree it never opened is worse than no
// guard, because it is believed. Skipped as root (who can read a 0000
// directory) and on win32 (no POSIX directory permissions).
const skipUnreadable =
  process.platform === 'win32' || (typeof process.getuid === 'function' && process.getuid() === 0);

test(
  'reports a directory it cannot traverse instead of calling it clean',
  { skip: skipUnreadable },
  () => {
    const { root } = makeTree();
    const locked = path.join(root, 'locked');
    fs.mkdirSync(locked);
    fs.writeFileSync(path.join(locked, 'hidden.dylib'), 'x');
    fs.chmodSync(path.join(locked, 'hidden.dylib'), 0o444);
    fs.chmodSync(locked, 0o000);

    try {
      const scan = findReadOnlyEntries(root);
      assert.equal(
        scan.unreadable.length,
        1,
        `expected one unreadable path, got ${JSON.stringify(scan.unreadable)}`,
      );
      assert.ok(scan.unreadable[0].startsWith('locked'), scan.unreadable[0]);
      // The read-only file inside it is invisible — which is exactly why an
      // empty offender list must not be read as a pass.
      assert.ok(!scan.offenders.some((o) => o.includes('hidden.dylib')));

      const fix = ensureOwnerWritable(root);
      assert.ok(
        fix.unreadable.some((u) => u.startsWith('locked')),
        `expected 'locked' in ${JSON.stringify(fix.unreadable)}`,
      );
    } finally {
      fs.chmodSync(locked, 0o755);
    }
  },
);
