import { snapshotDirName, snapshotsToPrune } from './snapshotRetention';

/**
 * Taking a pre-update database snapshot (#934, #926).
 *
 * Extracted behind an IO port for one specific reason: the defect this code
 * fixes was an *ordering* bug (pruning ran after the copy, so a full disk threw
 * before anything was ever reclaimed and every later update failed the same
 * way). An ordering invariant that lives only in a comment is not held - the
 * review's revert experiments demonstrated exactly that - so the order has to
 * be assertable.
 *
 * The encrypted secrets file travels with the database, as
 * `<snapshot>.secrets.enc`. The cluster holds stored credentials and dataset
 * cells encrypted with keys that live only in `secrets.enc`, so a cluster copy
 * without the matching file is not a restorable backup. A sibling file rather
 * than a file inside the cluster copy: a by-hand restore is obvious, and
 * directory-based retention cannot miscount it. `platform-data/` (the kernel's
 * own vault) is NOT part of the snapshot; see docs/security-architecture.md §8a.
 */

export interface SnapshotIo {
  exists(target: string): boolean;
  listDirectories(root: string): string[];
  copy(source: string, destination: string): void;
  /** Copy one file, leaving the copy readable by its owner only: it holds secrets. */
  copyFile(source: string, destination: string): void;
  /** Recursive; a missing path is not an error. */
  remove(target: string): void;
  info(message: string): void;
  error(message: string): void;
}

export interface SnapshotRequest {
  readonly sourceDir: string;
  /** The encrypted secrets file, copied next to the snapshot when it exists. */
  readonly secretsFile?: string;
  readonly snapshotRoot: string;
  readonly version: string;
  readonly now: Date;
  /** How many snapshots may exist once this one has been added. */
  readonly keep: number;
}

/** Appended to a snapshot directory's path for the secrets copy beside it. */
export const SECRETS_SNAPSHOT_SUFFIX = '.secrets.enc';

/**
 * Prune, then copy. Returns the new snapshot's path, or null when there was
 * nothing to snapshot (no database directory means no secrets copy either).
 *
 * Pruning to `keep - 1` first means peak disk usage is `keep` full clusters
 * rather than `keep + 1`, and - the actual bug - it means space is reclaimed
 * *before* the copy that might otherwise fail for want of it.
 */
export function takeDbSnapshot(io: SnapshotIo, request: SnapshotRequest): string | null {
  if (!io.exists(request.sourceDir)) return null;

  pruneSnapshots(io, request.snapshotRoot, Math.max(0, request.keep - 1));

  const destination = `${request.snapshotRoot}/${snapshotDirName(request.version, request.now)}`;
  const secretsCopy = `${destination}${SECRETS_SNAPSHOT_SUFFIX}`;
  try {
    io.copy(request.sourceDir, destination);
    if (request.secretsFile !== undefined && io.exists(request.secretsFile)) {
      io.copyFile(request.secretsFile, secretsCopy);
    }
  } catch (err) {
    // A half-copied snapshot is worse than none: it looks like a backup and
    // retention would count it as one, and a cluster without its secrets file
    // may not decrypt. Each cleanup gets its own try so a failure here cannot
    // replace the real cause the caller needs to report.
    for (const partial of [destination, secretsCopy]) {
      try {
        io.remove(partial);
      } catch (cleanupErr) {
        io.error(`could not remove the partial snapshot ${partial}: ${String(cleanupErr)}`);
      }
    }
    throw err;
  }
  io.info(`snapshotted DB → ${destination}`);
  return destination;
}

function pruneSnapshots(io: SnapshotIo, root: string, keep: number): void {
  try {
    for (const stale of snapshotsToPrune(io.listDirectories(root), keep)) {
      io.remove(`${root}/${stale}`);
      // Its secrets copy goes with it. Snapshots older than the copy have none,
      // which `remove` tolerates.
      io.remove(`${root}/${stale}${SECRETS_SNAPSHOT_SUFFIX}`);
      io.info(`pruned old snapshot ${stale}`);
    }
  } catch (err) {
    // Housekeeping: a failure here must not stop the snapshot that follows.
    io.error(`snapshot pruning failed: ${String(err)}`);
  }
}
