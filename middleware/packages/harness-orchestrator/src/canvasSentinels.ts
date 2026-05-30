/**
 * Omadia UI canvas sentinels (PR-7a) — pure parsers + the `canvas-output` gate.
 *
 * Tier-3 tools (and, for `_pendingMutation`, the canvas client) emit structured
 * canvas payloads as in-band JSON sentinels embedded in their result string —
 * the same mechanism as `_pendingUserChoice` / `_pendingRoutineList`
 * (`parseToolEmittedChoice` / `parseToolEmittedRoutineList` in orchestrator.ts).
 *
 * This module ships the PARSERS and the authorization GATE only. They are NOT
 * yet wired into the orchestrator tool loop: enforcing the gate needs the
 * boot-computed set of `canvas-output`-authorised tools threaded into the
 * orchestrator (cross-layer), which lands with the canvas orchestrator (PR-9),
 * alongside the actual tools that emit these sentinels. Until then nothing emits
 * them, so wiring the gate now would be speculative.
 *
 * Parsers are tolerant: malformed JSON or a shape mismatch yields `undefined`,
 * so a plain-text tool result stays a plain-text tool result. Types are
 * intentionally loose where the strong types live in the not-yet-merged canvas
 * SDK surface — `target` and `tree` stay `unknown` and are narrowed by the
 * consumer once `TargetRef` / the surface types land.
 */

/** Capability a tool/plugin must declare to be allowed to emit canvas sentinels. */
export const CANVAS_OUTPUT_CAPABILITY = 'canvas-output';

/**
 * Origin gate, **deny-by-default**. A canvas sentinel from a tool is only
 * honoured when that tool's plugin declared {@link CANVAS_OUTPUT_CAPABILITY}.
 * Undeclared / unknown origin → rejected. The authorised capability list is
 * supplied by the caller (computed at boot from the plugin catalog in PR-9).
 */
export function isCanvasOutputAuthorized(
  declaredCapabilities: readonly string[] | undefined,
): boolean {
  return declaredCapabilities?.includes(CANVAS_OUTPUT_CAPABILITY) ?? false;
}

/** Structured data payload a canvas-aware Tier-3 tool hands to Tier 2. */
export interface PendingStructuredPayload {
  prose: string;
  data: unknown;
  dataRefId: string;
  actions?: unknown[];
}

/** A full primitive tree a canvas-aware Tier-3 tool hands to Tier 2. */
export interface PendingCanvasTree {
  /** primitive tree (validated against the protocol whitelist by Tier 1). */
  tree: unknown;
}

/** A client-originated Class-D optimistic mutation awaiting resolution. */
export interface PendingMutation {
  mutationId: string;
  /** A `TargetRef` once the canvas SDK surface lands; `unknown` until consumed. */
  target: unknown;
  oldValue: unknown;
  newValue: unknown;
  /** Opaque `RevisionId` — a string at the wire layer. */
  basedOnRevision: string;
}

/** JSON.parse `content` and return the value at `key`, or `undefined`. Tolerant. */
function readSentinel(content: string, key: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  return (parsed as Record<string, unknown>)[key];
}

/** Parse a tool result for a `_pendingStructuredPayload` sidecar, or `undefined`. */
export function parseToolEmittedStructuredPayload(
  content: string,
): PendingStructuredPayload | undefined {
  const raw = readSentinel(content, '_pendingStructuredPayload');
  if (typeof raw !== 'object' || raw === null) return undefined;
  const r = raw as {
    prose?: unknown;
    data?: unknown;
    dataRefId?: unknown;
    actions?: unknown;
  };
  if (typeof r.prose !== 'string') return undefined;
  if (typeof r.dataRefId !== 'string' || r.dataRefId.length === 0) {
    return undefined;
  }
  if (!('data' in r)) return undefined;
  return {
    prose: r.prose,
    data: r.data,
    dataRefId: r.dataRefId,
    ...(Array.isArray(r.actions) ? { actions: r.actions } : {}),
  };
}

/** Parse a tool result for a `_pendingCanvasTree` sidecar, or `undefined`. */
export function parseToolEmittedCanvasTree(
  content: string,
): PendingCanvasTree | undefined {
  const raw = readSentinel(content, '_pendingCanvasTree');
  if (typeof raw !== 'object' || raw === null) return undefined;
  const r = raw as { tree?: unknown };
  if (typeof r.tree !== 'object' || r.tree === null) return undefined;
  return { tree: r.tree };
}

/** Parse a `_pendingMutation` sidecar (client → orchestrator), or `undefined`. */
export function parseToolEmittedMutation(
  content: string,
): PendingMutation | undefined {
  const raw = readSentinel(content, '_pendingMutation');
  if (typeof raw !== 'object' || raw === null) return undefined;
  const r = raw as {
    mutationId?: unknown;
    target?: unknown;
    oldValue?: unknown;
    newValue?: unknown;
    basedOnRevision?: unknown;
  };
  if (typeof r.mutationId !== 'string' || r.mutationId.length === 0) {
    return undefined;
  }
  if (typeof r.basedOnRevision !== 'string') return undefined;
  if (r.target === undefined || r.target === null) return undefined;
  // oldValue / newValue are required by the optimistic-update contract
  // (CONCEPT.md). The VALUE may legitimately be null (e.g. clearing a field),
  // so require key presence, not a non-null value.
  if (!('oldValue' in r) || !('newValue' in r)) return undefined;
  return {
    mutationId: r.mutationId,
    target: r.target,
    oldValue: r.oldValue,
    newValue: r.newValue,
    basedOnRevision: r.basedOnRevision,
  };
}
