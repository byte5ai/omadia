/**
 * Minimal semver parse/compare for the self-update surface (#432).
 *
 * Deliberately dependency-free: the only comparison this feature needs is
 * "is the released tag newer than the running build", over the tag shapes
 * `publish-images.yml` actually produces (`vX.Y.Z`, `X.Y.Z`, `X.Y`, plus the
 * non-semver floats `latest` / `edge` / `sha-<short>`). Pulling in the full
 * `semver` package for that would add a runtime dependency to the kernel for
 * ~40 lines of logic.
 *
 * Everything here treats a non-parsing input as "unknown", never as "older" —
 * an operator running `:edge` must not be told a release is an upgrade when
 * the comparison is meaningless.
 */

export interface ParsedVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  /** Dot-separated prerelease identifiers, empty for a final release. */
  readonly prerelease: readonly string[];
}

// Leading `v` is optional (GitHub tags carry it, compose tags may not).
// Build metadata (`+…`) is parsed and then ignored, per semver §10.
const SEMVER_RE =
  /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** Parse a release tag into comparable parts. Returns null for floating tags
 *  (`latest`, `edge`, `sha-1a2b3c4`) and anything else non-semver. */
export function parseVersion(raw: string | undefined | null): ParsedVersion | null {
  if (typeof raw !== 'string') return null;
  const match = SEMVER_RE.exec(raw.trim());
  if (!match) return null;
  const [, major, minor, patch, prerelease] = match;
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    prerelease: prerelease === undefined ? [] : prerelease.split('.'),
  };
}

/** Compare two prerelease identifier lists per semver §11: numeric identifiers
 *  compare numerically, alphanumerics lexically, numeric < alphanumeric, and a
 *  shorter prefix-equal list is lower. */
function comparePrerelease(
  a: readonly string[],
  b: readonly string[],
): number {
  // A version WITHOUT prerelease outranks the same version with one.
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;

  const shared = Math.min(a.length, b.length);
  for (let i = 0; i < shared; i += 1) {
    const left = a[i] as string;
    const right = b[i] as string;
    if (left === right) continue;
    const leftNum = /^\d+$/.test(left);
    const rightNum = /^\d+$/.test(right);
    if (leftNum && rightNum) return Number(left) - Number(right);
    if (leftNum) return -1;
    if (rightNum) return 1;
    return left < right ? -1 : 1;
  }
  return a.length - b.length;
}

/** Negative if `a` < `b`, 0 if equal, positive if `a` > `b`. */
export function compareVersions(a: ParsedVersion, b: ParsedVersion): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  return comparePrerelease(a.prerelease, b.prerelease);
}

/**
 * True only when BOTH tags parse and `latest` is strictly newer than
 * `current`. An unknown/floating current tag yields false: we cannot prove an
 * upgrade, and a false "update available" badge on an `:edge` deployment would
 * push operators to downgrade onto the last release.
 */
export function isNewerVersion(
  current: string | undefined | null,
  latest: string | undefined | null,
): boolean {
  const runningVersion = parseVersion(current);
  const candidate = parseVersion(latest);
  if (runningVersion === null || candidate === null) return false;
  return compareVersions(candidate, runningVersion) > 0;
}

/** Canonical display/tag form: always `vX.Y.Z[-pre]`. Non-semver input is
 *  returned trimmed and unchanged (a floating tag is its own display form). */
export function toTag(raw: string): string {
  const parsed = parseVersion(raw);
  if (parsed === null) return raw.trim();
  const base = `v${parsed.major}.${parsed.minor}.${parsed.patch}`;
  return parsed.prerelease.length > 0
    ? `${base}-${parsed.prerelease.join('.')}`
    : base;
}
