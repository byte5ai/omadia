/**
 * Naming and pruning pre-update database snapshots (#934).
 *
 * The previous scheme wrote every attempt to the same `pgdata-pre-<version>`
 * directory after removing it first, so a second update attempt for the same
 * version destroyed the backup the first one had made. Three attempts in one
 * morning left exactly one snapshot, and it was the one taken last - after the
 * stack had already been through two failed handoffs. The safety net got
 * thinner with every retry instead of thicker.
 */

export const SNAPSHOT_PREFIX = 'pgdata-pre-';

/** How many snapshots to keep. Each one is a full copy of the cluster. */
export const SNAPSHOTS_TO_KEEP = 3;

/** `2026-08-28T13:05:32.119Z` -> `20260828T130532119Z`, safe on every filesystem. */
function compactTimestamp(now: Date): string {
  return now.toISOString().replace(/[-:.]/g, '');
}

const TIMESTAMP_RE = /^(\d{8}T\d{9}Z)$/;

/** A unique directory name per attempt, lexically sortable by time. */
export function snapshotDirName(version: string, now: Date): string {
  return `${SNAPSHOT_PREFIX}${version}-${compactTimestamp(now)}`;
}

export interface ParsedSnapshotName {
  readonly version: string;
  /** Compact timestamp, or null for a legacy name that carried none. */
  readonly stamp: string | null;
}

export function parseSnapshotName(name: string): ParsedSnapshotName | null {
  if (!name.startsWith(SNAPSHOT_PREFIX)) return null;
  const rest = name.slice(SNAPSHOT_PREFIX.length);
  if (rest.length === 0) return null;

  const lastDash = rest.lastIndexOf('-');
  if (lastDash > 0) {
    const candidate = rest.slice(lastDash + 1);
    if (TIMESTAMP_RE.test(candidate)) {
      return { version: rest.slice(0, lastDash), stamp: candidate };
    }
  }
  // Pre-#934 snapshots have no timestamp segment. They are still real backups,
  // so they are kept in the ordering rather than ignored - just treated as
  // oldest, because we cannot tell when they were taken.
  return { version: rest, stamp: null };
}

/**
 * The snapshot directory names to delete, oldest first, so that at most `keep`
 * remain. Anything that is not a snapshot name is left completely alone.
 */
export function snapshotsToPrune(
  names: readonly string[],
  keep: number = SNAPSHOTS_TO_KEEP,
): string[] {
  const snapshots = names
    .map((name) => ({ name, parsed: parseSnapshotName(name) }))
    .filter((entry): entry is { name: string; parsed: ParsedSnapshotName } => entry.parsed !== null);

  // Newest first: a missing stamp sorts last (oldest). Ties fall back to the
  // name so the result is deterministic.
  const newestFirst = [...snapshots].sort((a, b) => {
    const left = a.parsed.stamp;
    const right = b.parsed.stamp;
    if (left === right) return a.name.localeCompare(b.name);
    if (left === null) return 1;
    if (right === null) return -1;
    return right.localeCompare(left);
  });

  const surplus = Math.max(0, newestFirst.length - Math.max(0, keep));
  return newestFirst.slice(newestFirst.length - surplus).map((entry) => entry.name);
}
