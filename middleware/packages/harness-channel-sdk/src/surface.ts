/**
 * Omadia UI canvas surface contracts (omadia-canvas-protocol/1.0).
 *
 * These types are ADDITIVE to the channel SDK: the `SurfaceStreamEvent` family
 * is folded into `ChatStreamEvent` (chatAgent.ts) as new discriminated arms, and
 * `OutgoingSurface` rides on `SemanticAnswer`. Classic channels never declare
 * the `'canvas'` capability and default-ignore every `surface_*` event, so this
 * surface is inert for them.
 *
 * Nothing here changes an existing type — it only adds new ones.
 */

import type { TargetRef } from '@omadia/plugin-api';

/**
 * Opaque revision identifier for a canvas tree. Compared by EQUALITY ONLY — never
 * with `<` / `>` / arithmetic. v1 implements it as a monotonic integer rendered
 * as a string (single-writer model); v2+ shared canvases may use Lamport
 * timestamps / vector clocks / CRDT op-ids without any wire-format change. The
 * brand prevents accidental arithmetic or cross-use with a plain string.
 */
export type RevisionId = string & { readonly __brand: 'RevisionId' };

/**
 * Canonical reference to bulk data behind a primitive. Content-addressed id,
 * HMAC-signed token, expiry. The single shape used by every trait/event that
 * references bulk data.
 */
export interface DataRef {
  /** content-addressed identifier, e.g. `"pixel-<sha256[:16]>"` */
  id: string;
  /** HMAC signature (see Security Surface for input composition) */
  signedToken: string;
  /** ISO 8601 timestamp */
  expiresAt: string;
  /** protocol 1.1 (omadia-ui#5): true → the server can re-resolve this data
   *  deterministically (a refresh recipe exists); the client may surface an
   *  instant-refresh affordance. Absent = unknown (agent-fallback refresh). */
  refreshable?: boolean;
  /** protocol 1.1: the canvas container this ref's data feeds (table/chart id) */
  containerId?: string;
}

/** Fields every surface event carries. `surfaceSeq` is server-assigned, monotonic per canvasSessionId. */
interface SurfaceEventBase {
  canvasSessionId: string;
  surfaceSeq: number;
}

/** Initial render / full replace; starts a new revision. */
export interface SurfaceSnapshotEvent extends SurfaceEventBase {
  type: 'surface_snapshot';
  producesRevision: RevisionId;
  /** full primitive tree (validated against the protocol whitelist by Tier 1) */
  tree: unknown;
  protocolVersion: string;
  opsCatalogVersion: string;
}

/** Incremental update; client rejects + requests a snapshot if `basedOnRevision` mismatches. */
export interface SurfacePatchEvent extends SurfaceEventBase {
  type: 'surface_patch';
  basedOnRevision: RevisionId;
  producesRevision: RevisionId;
  /** tree-path-targeted mutations */
  patches: unknown[];
}

/** Bulk data available behind a signed reference. */
export interface SurfaceDataRefCreatedEvent extends SurfaceEventBase {
  type: 'surface_data_ref_created';
  revision: RevisionId;
  dataRef: DataRef;
  schema?: unknown;
  sizeHint?: number;
}

/** A reference expired / changed. */
export interface SurfaceDataRefInvalidatedEvent extends SurfaceEventBase {
  type: 'surface_data_ref_invalidated';
  revision: RevisionId;
  id: string;
  reason: string;
}

/** Result of a user-triggered action. */
export interface SurfaceActionResultEvent extends SurfaceEventBase {
  type: 'surface_action_result';
  forActionId: string;
  basedOnRevision: RevisionId;
  status: string;
  message?: string;
  followUpPatch?: unknown;
}

/**
 * Tier 2 instructs Tier 1 to execute a Local Operations Catalog operation.
 * `effect: 'preview'` does NOT mutate the revision (transient, locally undo-able);
 * `effect: 'durable'` is always followed by a `surface_patch` that mutates it.
 */
export interface SurfaceLocalActionEvent extends SurfaceEventBase {
  type: 'surface_local_action';
  revision: RevisionId;
  effect: 'preview' | 'durable';
  operation: string;
  params: unknown;
  target: TargetRef;
}

/** Render-side validation / dataRef denied / catalog op unknown / protocol mismatch. */
export interface SurfaceErrorEvent extends SurfaceEventBase {
  type: 'surface_error';
  revision: RevisionId;
  severity: string;
  message: string;
  scope?: unknown;
}

/**
 * Resolution of a Class-D mutation, correlated to its `_pendingMutation` by
 * `forMutationId`. v2+ multi-user reserves `originAuthor` / `originSession` so a
 * member can be shown who applied a change and from which session — empty in v1.
 */
export interface SurfaceMutationResolvedEvent extends SurfaceEventBase {
  type: 'surface_mutation_resolved';
  revision: RevisionId;
  forMutationId: string;
  status: 'success' | 'modified' | 'rejected' | 'invalid' | 'conflict';
  /** present when modified or conflict */
  actualValue?: unknown;
  /** present when rejected or invalid */
  error?: { message: string; code?: string };
  /** v2+ multi-user provenance — empty in v1 single-user */
  originAuthor?: string;
  originSession?: string;
}

/**
 * The `surface_*` event family added to `ChatStreamEvent`. Folded in as new arms
 * in chatAgent.ts via `| SurfaceStreamEvent`.
 */
export type SurfaceStreamEvent =
  | SurfaceSnapshotEvent
  | SurfacePatchEvent
  | SurfaceDataRefCreatedEvent
  | SurfaceDataRefInvalidatedEvent
  | SurfaceActionResultEvent
  | SurfaceLocalActionEvent
  | SurfaceErrorEvent
  | SurfaceMutationResolvedEvent;

/**
 * Canvas surface payload carried on a `SemanticAnswer` (and as
 * `ChatTurnResult.surface`) when a canvas-aware turn produced an initial tree.
 * Channels not declaring `'canvas'` ignore it.
 */
export interface OutgoingSurface {
  canvasSessionId: string;
  producesRevision: RevisionId;
  /** full primitive tree */
  tree: unknown;
  protocolVersion: string;
  opsCatalogVersion: string;
}

/** Kernel-shaped counterpart of `OutgoingSurface` on `ChatTurnResult`. */
export type PendingCanvasSurface = OutgoingSurface;
