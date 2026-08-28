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
 */

export interface SnapshotIo {
  exists(dir: string): boolean;
  listDirectories(root: string): string[];
  copy(source: string, destination: string): void;
  remove(dir: string): void;
  info(message: string): void;
  error(message: string): void;
}

export interface SnapshotRequest {
  readonly sourceDir: string;
  readonly snapshotRoot: string;
  readonly version: string;
  readonly now: Date;
  /** How many snapshots may exist once this one has been added. */
  readonly keep: number;
}

/**
 * Prune, then copy. Returns the new snapshot's path, or null when there was
 * nothing to snapshot.
 *
 * Pruning to `keep - 1` first means peak disk usage is `keep` full clusters
 * rather than `keep + 1`, and - the actual bug - it means space is reclaimed
 * *before* the copy that might otherwise fail for want of it.
 */
export function takeDbSnapshot(io: SnapshotIo, request: SnapshotRequest): string | null {
  if (!io.exists(request.sourceDir)) return null;

  pruneSnapshots(io, request.snapshotRoot, Math.max(0, request.keep - 1));

  const destination = `${request.snapshotRoot}/${snapshotDirName(request.version, request.now)}`;
  try {
    io.copy(request.sourceDir, destination);
  } catch (err) {
    // A half-copied directory is worse than none: it looks like a backup and
    // retention would count it as one. The cleanup gets its own try so a
    // failure here cannot replace the real cause the caller needs to report.
    try {
      io.remove(destination);
    } catch (cleanupErr) {
      io.error(`could not remove the partial snapshot ${destination}: ${String(cleanupErr)}`);
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
      io.info(`pruned old snapshot ${stale}`);
    }
  } catch (err) {
    // Housekeeping: a failure here must not stop the snapshot that follows.
    io.error(`snapshot pruning failed: ${String(err)}`);
  }
}
