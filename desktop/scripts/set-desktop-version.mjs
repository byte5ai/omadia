// Writes the release version into desktop/package.json before packaging.
//
// WHY THIS EXISTS
// desktop/package.json intentionally stays at the placeholder version 0.1.0 in
// git, but electron-builder reads THAT field for three separate release-facing
// surfaces: the packaged app's Info.plist (what macOS shows in "About omadia"),
// the generated artifact filenames, and the version electron-updater compares
// against the release feed. Leaving it at 0.1.0 meant every shipped build
// claimed to be 0.1.0 and the updater could not compare releases correctly.
// CI therefore overwrites the field from the release tag immediately before the
// build/pack steps that consume it.
//
// Usage: node set-desktop-version.mjs <tag>
//
// Deliberately dependency-free: this runs in CI and needs only Node's stdlib.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const here = path.dirname(fileURLToPath(import.meta.url));
const desktopPackageJsonPath = path.join(here, '..', 'package.json');

/**
 * Converts a release tag into the bare semver electron-builder expects.
 *
 * Accepts either `vX.Y.Z` or `X.Y.Z`, strips at most one leading `v`, and
 * rejects anything else so CI fails before producing mislabeled artifacts.
 */
export function deriveVersion(tag) {
  const value = typeof tag === 'string' ? tag : '';
  const version = value.startsWith('v') ? value.slice(1) : value;
  if (!VERSION_RE.test(version)) {
    throw new Error(`Invalid version tag: "${tag}" — expected vX.Y.Z or X.Y.Z`);
  }
  return version;
}

/**
 * Rewrites package.json with the release version while preserving the repo's
 * exact formatting: 2-space indent and one trailing newline.
 */
export function setPackageVersion(packageJsonText, version) {
  const pkg = JSON.parse(packageJsonText);
  pkg.version = version;
  return `${JSON.stringify(pkg, null, 2)}\n`;
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const tag = process.argv[2];
  if (!tag) {
    console.error('usage: set-desktop-version.mjs <tag>');
    process.exit(1);
  }

  const version = deriveVersion(tag);
  const next = setPackageVersion(fs.readFileSync(desktopPackageJsonPath, 'utf8'), version);
  fs.writeFileSync(desktopPackageJsonPath, next);
  console.log(`desktop/package.json version -> ${version}`);
}
