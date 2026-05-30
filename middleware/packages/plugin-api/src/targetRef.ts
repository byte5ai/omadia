/**
 * `TargetRef` — the single canonical way to address "a target" anywhere in the
 * Omadia UI canvas protocol. Beam targets, Class-D `_pendingMutation.target`,
 * `suggestedActions.target`, `surface_local_action.target` and
 * `surface_mutation_resolved` correlation all use this one discriminated union.
 *
 * Targets address data by STABLE id/hash, never by view position ("row 3 on
 * screen" is not addressable). Tier 1 resolves a `TargetRef` against its current
 * tree + view-state by switching on `kind`; an unknown `kind` is rejected.
 *
 * Additive: new to the plugin-api surface. No existing type references it; it is
 * a fresh shared contract consumed by the channel-sdk (`IncomingTurn.target`,
 * `surface_local_action`) and future canvas plugins.
 */
export type TargetRef =
  | { kind: 'canvas'; canvasSessionId: string }
  | { kind: 'container'; containerId: string }
  /** any non-data primitive (heading, divider, status, …) */
  | { kind: 'element'; elementId: string }
  | { kind: 'rowField'; containerId: string; rowKey: string; fieldKey: string }
  /** list / tree node */
  | { kind: 'item'; containerId: string; itemKey: string }
  /** chart data point */
  | { kind: 'point'; containerId: string; pointKey: string }
  | { kind: 'textRange'; anchor: TextRangeAnchor }
  /** pixel / canvas-region region */
  | { kind: 'region'; region: BufferRegion }
  /** whole-buffer reference (canvas-region / media) */
  | { kind: 'buffer'; primitiveId: string; bufferContentHash: string }
  /**
   * media / timeline trim / splice / scrub. `trackId` scopes to one track on a
   * multi-track timeline; `clipId` targets a specific clip on that track rather
   * than a raw time interval. For single-buffer media omit both; for a
   * multi-track timeline `trackId` is required and `clipId` optional.
   */
  | {
      kind: 'timeRange';
      primitiveId: string;
      bufferContentHash: string;
      start: number;
      end: number;
      unit: 'seconds' | 'samples' | 'frames';
      trackId?: string;
      clipId?: string;
    };

/**
 * Stable anchor for a range within a `text` primitive. Naked numeric offsets are
 * unstable as soon as the text is patched, so the offsets are bound to a content
 * hash; on a hash miss the client re-anchors via `fallbackSegment`.
 */
export interface TextRangeAnchor {
  /** the text primitive's containerId or elementId */
  primitiveId: string;
  /** sha256[:16] of the text primitive's content at anchoring time */
  contentHash: string;
  /** byte offset within that exact content */
  start: number;
  /** byte offset within that exact content */
  end: number;
  /** optional string snippets for re-resolution on a hash miss */
  fallbackSegment?: {
    /** ~32 chars of context before the selection */
    before: string;
    /** the selected text itself */
    selection: string;
    /** ~32 chars of context after the selection */
    after: string;
  };
}

/**
 * Region addressing on `canvas-region` and `media` buffers, in buffer-native
 * (not viewport / display) coordinates so zoom + pan do not invalidate it. A
 * `bufferContentHash` mismatch means the buffer changed and the region can no
 * longer be safely interpreted.
 */
export interface BufferRegion {
  /** the canvas-region or media primitive's elementId */
  primitiveId: string;
  /** sha256[:16] of the buffer at anchoring time (resolution fails on mismatch) */
  bufferContentHash: string;
  /** axis-aligned bounding box in buffer pixels */
  bbox: { x: number; y: number; w: number; h: number };
  /** optional shape for non-rect selections (lasso, magic-wand) */
  shape?: {
    kind: 'rect' | 'polygon' | 'mask';
    /** for 'polygon' */
    points?: Array<[number, number]>;
    /** for 'mask' — content-hash of a binary mask sized to bbox */
    maskHash?: string;
  };
}
