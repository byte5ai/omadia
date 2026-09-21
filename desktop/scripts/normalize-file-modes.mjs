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

// Cato-Audit Runde 5 / OM-86 follow-up: both walks used to `return` silently
// when `readdirSync` threw. An unreadable directory (0000, or an EPERM under a
// signed bundle) therefore produced an EMPTY offender list, which
// stage-runtime.mjs reads as "the tree is clean" — the exact silent-pass shape
// the OM-86 gate exists to remove, only one level up: the gate cannot see the
// subtree that most plausibly holds the read-only file. So the errors are
// COLLECTED and returned, and the caller refuses to stage a tree it could not
// fully inspect. "Not scanned" is never "scanned and clean".

/**
 * Walk `root` and add the owner-write bit wherever it is missing.
 *
 * @param {string} root
 * @returns {{ fixed: string[], unreadable: string[] }} paths (relative to
 *   `root`) that were changed, and directories that could not be traversed
 */
export function ensureOwnerWritable(root) {
  const fixed = [];
  const unreadable = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      unreadable.push(`${path.relative(root, dir) || '.'} (${describe(err)})`);
      return;
    }
    for (const entry of entries) {
      const p = path.join(dir, entry.name);
      // Dirent flags are lstat-based, so a symlink is never followed here.
      if (entry.isSymbolicLink()) continue;
      let mode;
      try {
        mode = fs.lstatSync(p).mode;
      } catch (err) {
        unreadable.push(`${path.relative(root, p)} (${describe(err)})`);
        continue;
      }
      if ((mode & OWNER_WRITE) === 0) {
        // A chmod that fails is exactly as invisible as a skipped directory,
        // and leaves the very bit that broke OM-86 in place.
        try {
          fs.chmodSync(p, (mode & 0o7777) | OWNER_WRITE);
        } catch (err) {
          unreadable.push(`${path.relative(root, p)} (chmod: ${describe(err)})`);
          continue;
        }
        fixed.push(path.relative(root, p));
      }
      if (entry.isDirectory()) walk(p);
    }
  };
  walk(root);
  return { fixed, unreadable };
}

/** Error → one short line, without assuming it is an `Error` at all. */
function describe(err) {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The gate: after {@link ensureOwnerWritable}, nothing may be left read-only.
 * Returns the offending paths so the caller can print them and refuse to ship,
 * plus whatever could not be inspected — see the note above on why an
 * unreadable directory must not read as a clean one.
 *
 * @param {string} root
 * @returns {{ offenders: string[], unreadable: string[] }}
 */
export function findReadOnlyEntries(root) {
  const offenders = [];
  const unreadable = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      unreadable.push(`${path.relative(root, dir) || '.'} (${describe(err)})`);
      return;
    }
    for (const entry of entries) {
      const p = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      let mode;
      try {
        mode = fs.lstatSync(p).mode;
      } catch (err) {
        unreadable.push(`${path.relative(root, p)} (${describe(err)})`);
        continue;
      }
      if ((mode & OWNER_WRITE) === 0) offenders.push(path.relative(root, p));
      if (entry.isDirectory()) walk(p);
    }
  };
  walk(root);
  return { offenders, unreadable };
}
