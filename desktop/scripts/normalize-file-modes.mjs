// Makes every regular file and directory in a staged tree writable by its
// owner (OM-86, beta round 5).
//
// Why this exists: on macOS the release archive shipped exactly ONE file out
// of 25,895 without the owner-write bit — `omadia-pg/lib/postgresql/vector.dylib`,
// mode 0444. Homebrew keeps its keg read-only and the CI `cp` preserved the
// mode. Squirrel/ShipIt strips the quarantine xattr from EVERY file of a
// downloaded update before swapping it in; removing an xattr is a write, so on
// that one file it failed with EACCES ("Couldn't remove quarantine attribute …
// This most likely means the file is read-only"), and no macOS install could
// self-update from 0.152.0 to anything newer. The fix that healed the boot
// crash of those versions (0.154.1) existed for three days and was unreachable.
//
// The CI step that copies pgvector now chmods its files too; this pass is the
// second layer, over the WHOLE staged tree, so the next read-only file from a
// package tarball or a keg cannot reproduce the failure. Symlinks are skipped:
// chmod follows them, and the engine's relative dylib chain must stay untouched.
//
// Runs on every platform for simplicity; on Windows `fs.chmodSync` only toggles
// the read-only attribute, which is exactly the intent.
import fs from 'node:fs';
import path from 'node:path';

const OWNER_WRITE = 0o200;

/**
 * Walk `root` and add the owner-write bit wherever it is missing.
 *
 * @param {string} root
 * @returns {{ fixed: string[] }} the paths (relative to root) that were changed
 */
export function ensureOwnerWritable(root) {
  const fixed = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const p = path.join(dir, entry.name);
      // Dirent flags are lstat-based, so a symlink is never followed here.
      if (entry.isSymbolicLink()) continue;
      const mode = fs.lstatSync(p).mode;
      if ((mode & OWNER_WRITE) === 0) {
        fs.chmodSync(p, (mode & 0o7777) | OWNER_WRITE);
        fixed.push(path.relative(root, p));
      }
      if (entry.isDirectory()) walk(p);
    }
  };
  walk(root);
  return { fixed };
}

/**
 * The gate: after {@link ensureOwnerWritable}, nothing may be left read-only.
 * Returns the offending paths so the caller can print them and refuse to ship.
 *
 * @param {string} root
 * @returns {string[]}
 */
export function findReadOnlyEntries(root) {
  const offenders = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const p = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if ((fs.lstatSync(p).mode & OWNER_WRITE) === 0) offenders.push(path.relative(root, p));
      if (entry.isDirectory()) walk(p);
    }
  };
  walk(root);
  return offenders;
}
