import { parseVersion } from './semver.js';

/**
 * The running build's identity (#432, slice 1).
 *
 * Source of truth is the `OMADIA_VERSION` environment variable, stamped into
 * the image at build time by `publish-images.yml` and mirrored by compose onto
 * the running container. `middleware/package.json` is deliberately NOT a
 * fallback: it has read `0.2.0` since long before the current release series
 * (v0.74.0 at the time of writing), so falling back to it does not degrade to
 * "less precise" — it degrades to *confidently wrong*, which is worse than
 * admitting the build is unstamped. `web-ui/app/_lib/appVersion.ts` had exactly
 * that bug and printed `0.2.0` on the help page of every release.
 *
 * The `source` discriminator is what lets callers behave correctly instead of
 * guessing from the string:
 *   - `release`  — a semver tag; version comparison against GitHub is meaningful
 *   - `floating` — `latest` / `edge` / `sha-<short>`; the container tracks a
 *                  moving tag, so "newer release available" is undecidable
 *   - `unknown`  — unstamped build (local `npm start`, or an image built
 *                  without the build arg)
 */

export type VersionSource = 'release' | 'floating' | 'unknown';

export interface AppVersion {
  /** Raw tag as stamped, e.g. `v0.74.0` / `edge`. `unknown` when unstamped. */
  readonly version: string;
  readonly source: VersionSource;
}

export const UNKNOWN_VERSION = 'unknown';

/** Resolve the running build's version from an environment bag (injectable so
 *  tests never mutate `process.env`). */
export function resolveAppVersion(
  env: Readonly<Record<string, string | undefined>> = process.env,
): AppVersion {
  const raw = env['OMADIA_VERSION']?.trim();
  if (raw === undefined || raw.length === 0) {
    return { version: UNKNOWN_VERSION, source: 'unknown' };
  }
  return {
    version: raw,
    source: parseVersion(raw) === null ? 'floating' : 'release',
  };
}
