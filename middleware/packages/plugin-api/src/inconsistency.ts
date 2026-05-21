/**
 * @omadia/plugin-api — Inconsistency Detection capability (Slice 9).
 *
 * Two semantically-similar MemorableKnowledge nodes whose CONTENT
 * disagrees become an `Inconsistency` node with two
 * `CONFLICTS_WITH` edges (one per offending MK). The detector runs
 * fire-and-forget post-COMMIT after MK creates / updates / auto-
 * promotions. Operator resolves manually via /admin/inconsistencies.
 */

export type InconsistencyStatus = 'open' | 'resolved' | 'dismissed';

export type InconsistencyResolution =
  /** Memory A is correct → memory B was deleted. */
  | 'a_wins'
  /** Memory B is correct → memory A was deleted. */
  | 'b_wins'
  /** Both are correct in different contexts; conflict acknowledged
   *  but no data loss. */
  | 'both'
  /** Detector was wrong; not a real conflict. */
  | 'dismiss';

export type InconsistencySeverity = 'low' | 'medium' | 'high';

export interface InconsistencyNode {
  /** External id, scheme `inconsistency:<uuid>`. */
  id: string;
  type: 'Inconsistency';
  props: {
    summary: string;
    severity: InconsistencySeverity;
    status: InconsistencyStatus;
    resolution: InconsistencyResolution | null;
    created_at: string;
    resolved_at: string | null;
    /** Cluster-root that resolved the conflict; null while open. */
    resolved_by: string | null;
  };
  /** External ids of the two conflicting MKs, sorted ascending so
   *  dedupe-checks are direction-independent. */
  conflictsWith: [string, string];
}

export interface ListInconsistenciesOptions {
  /** Cluster-root id of the viewer; ACL gate is non-bypassable. */
  viewerOmadiaUserId: string;
  status?: InconsistencyStatus;
  /** Max hits, clamped to [1, 200]. Default 50. */
  limit?: number;
}

export interface CreateInconsistencyInput {
  mkAExternalId: string;
  mkBExternalId: string;
  summary: string;
  severity: InconsistencySeverity;
}

/**
 * Service surface published by the detector provider. The route
 * layer re-uses this for the manual re-detect button on a single MK.
 */
export interface InconsistencyDetectorService {
  detectFor(memorableKnowledgeNodeId: string): Promise<{
    candidatesScanned: number;
    inconsistenciesCreated: number;
  }>;
}

export const INCONSISTENCY_DETECTOR_SERVICE_NAME = 'inconsistencyDetector';
export const INCONSISTENCY_DETECTOR_CAPABILITY = 'inconsistencyDetector@1';
