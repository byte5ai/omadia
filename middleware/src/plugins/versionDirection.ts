import { compareVersions, parseVersion } from '../update/semver.js';

/**
 * #1455 — which way a plugin version moved.
 *
 * Its own module rather than a helper inside `packageUploadService.ts`: the
 * migration runner logs the direction too, and importing it from the upload
 * service would pair a runtime import with the type-only import that already
 * points the other way.
 */

/**
 * How the ingested version sorts against the one it replaces. Callers pair it
 * with `null` for "no direction", which covers three cases: a first upload;
 * two versions of equal precedence (the identical string, which the
 * duplicate-version refusal owns, or two differing only in build metadata,
 * excluded from precedence by semver §10); and a pair that cannot be compared
 * at all.
 */
export type VersionChangeDirection = 'upgrade' | 'downgrade';

/**
 * Does `to` sort above or below `from`?
 *
 * Both sides come from a `manifest.identity.version` that `manifestLoader`
 * already accepted as strict semver, so in practice both parse. A side that
 * does not (a hand-edited `index.json`) yields `null`: the ingest then goes
 * through, because a refusal must not rest on a comparison that did not
 * happen, and nothing reports a direction — labelling it `upgrade` would put
 * a direction nobody computed into the response and the log.
 *
 * Shares `update/semver.ts` with the self-update surface rather than adding a
 * third comparator (`routes/store.ts` carries a local one for its update
 * banner), because prerelease ordering is the part that is easy to get wrong:
 * `1.0.0-rc.1 → 1.0.0` is an upgrade, the reverse a downgrade.
 */
export function versionDirection(
  from: string,
  to: string,
): VersionChangeDirection | null {
  if (from === to) return null;
  const previous = parseVersion(from);
  const next = parseVersion(to);
  if (previous === null || next === null) return null;
  const order = compareVersions(next, previous);
  if (order === 0) return null;
  return order < 0 ? 'downgrade' : 'upgrade';
}
