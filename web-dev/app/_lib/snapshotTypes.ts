/**
 * Profile-Snapshot wire types (OB-83 + OB-64).
 *
 * Mirrors the shape returned by the middleware routes under
 *   /api/v1/profiles/:id/snapshot[s]
 *
 * Kept in this lib (not in builderTypes.ts) because Profile-Snapshots are
 * a profile-level concept that's bridged from the builder via the
 * `draft_id == profile_id` invariant — keeping them separate makes it
 * obvious that a future RSC consumer can pull them in without depending
 * on the rest of the builder type surface.
 */

export type SnapshotAssetStatus =
  | 'added'
  | 'removed'
  | 'modified'
  | 'identical';

export interface SnapshotSummary {
  snapshot_id: string;
  profile_id: string;
  profile_version: string;
  bundle_hash: string;
  bundle_size_bytes: number;
  created_at: string;
  created_by: string;
  notes: string | null;
  is_deploy_ready: boolean;
  deploy_ready_at: string | null;
  deploy_ready_by: string | null;
}

export interface SnapshotAsset {
  path: string;
  sha256: string;
  size_bytes: number;
}

export interface SnapshotDetail extends SnapshotSummary {
  drift_score: number | null;
  manifest_yaml: string;
  assets: SnapshotAsset[];
}

export interface ListSnapshotsResponse {
  snapshots: SnapshotSummary[];
}

export interface CaptureSnapshotResponse {
  snapshot_id: string;
  bundle_hash: string;
  bundle_size_bytes: number;
  created_at: string;
  was_existing: boolean;
}

export interface CaptureSnapshotBody {
  notes?: string;
  vendor?: boolean;
}

export interface RollbackResponse {
  rolled_back_to: { snapshot_id: string; bundle_hash: string };
  applied_at: string;
  diverged_assets: string[];
}

export interface AssetDiffEntry {
  path: string;
  status: SnapshotAssetStatus;
  base_sha256: string | null;
  target_sha256: string | null;
}

export interface DiffResponse {
  diffs: AssetDiffEntry[];
}

/** `'live'` or a snapshot UUID — the route accepts either. */
export type DiffSideRef = string;
