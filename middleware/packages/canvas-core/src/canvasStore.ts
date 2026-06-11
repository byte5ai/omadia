import { SURFACE_EVENT_TYPES, type ServerMessage, type SurfaceEvent } from './protocol.js';
import { applyTreePatches } from './treePatch.js';
import { validateSurfaceEvent, validateTree } from './validator.js';

/** How the current tree arrived — drives the visual-spec §6.1 motion split:
 *  snapshot → full-canvas crossfade; patch → condensation on changed nodes. */
export interface CanvasApply {
  kind: 'snapshot' | 'patch';
  revision: string;
  /** deepest node ids whose subtree a patch touched (empty for snapshots) */
  changedIds: readonly string[];
  /** §3.5 rapid-stream throttling: >5 patches in the last second */
  rapid: boolean;
}

export interface CanvasState {
  tree: unknown | null;
  /** opaque RevisionId — equality-only comparisons (protocol §0) */
  revision: string | null;
  /** revision of the snapshot that opened the current run — stable React key
   *  for the canvas wrapper, so patches never remount the whole tree */
  snapshotRevision: string | null;
  lastApply: CanvasApply | null;
  /** patch-arrival timestamps inside the §3.5 1s sliding window */
  patchTimes: readonly number[];
  lastSurfaceSeq: number | null;
  prose: string;
  turnPending: boolean;
  /** last turn_error message — the beam pin renders it as an inline chip */
  turnError: string | null;
  connection: 'disconnected' | 'connecting' | 'ready' | 'failed';
  /** debug/UX strip: errors, rejections, not-yet-rendered event kinds */
  notices: string[];
  /** client-side view history: previous server-authoritative trees, newest
   *  last. Back is view-only — Layer-2 persistence is a later slice. */
  history: Array<{ tree: unknown; revision: string }>;
}

export const initialCanvasState: CanvasState = {
  tree: null,
  revision: null,
  snapshotRevision: null,
  lastApply: null,
  patchTimes: [],
  lastSurfaceSeq: null,
  prose: '',
  turnPending: false,
  turnError: null,
  connection: 'disconnected',
  notices: [],
  history: [],
};

const nodeId = (n: unknown): string | undefined => {
  if (typeof n !== 'object' || n === null) return undefined;
  const id = (n as Record<string, unknown>)['id'];
  return typeof id === 'string' ? id : undefined;
};

/** For each patch path, the deepest node carrying an `id` along the pointer
 *  walk (against the pre-patch tree — paths are authored on basedOnRevision).
 *  These nodes get the §3.5 condensation treatment after the patch applies. */
export function changedNodeIds(tree: unknown, patches: unknown[]): string[] {
  const ids = new Set<string>();
  for (const p of patches) {
    if (typeof p !== 'object' || p === null) continue;
    const path = (p as { path?: unknown }).path;
    if (typeof path !== 'string' || !path.startsWith('/')) continue;
    const segments = path
      .split('/')
      .slice(1)
      .map((seg) => seg.replace(/~1/g, '/').replace(/~0/g, '~'));
    let node: unknown = tree;
    let deepest = nodeId(node);
    for (const seg of segments) {
      if (Array.isArray(node)) {
        const idx = Number(seg);
        node = Number.isInteger(idx) ? node.at(idx) : undefined;
      } else if (typeof node === 'object' && node !== null) {
        node = (node as Record<string, unknown>)[seg];
      } else {
        break;
      }
      deepest = nodeId(node) ?? deepest;
    }
    if (deepest !== undefined) ids.add(deepest);
  }
  return [...ids];
}

/** restore the previous view (no server round-trip). A later patch on the
 *  restored revision will mismatch and trigger a resync — acceptable for the
 *  view-only back slice. */
export function goBack(state: CanvasState): CanvasState {
  const prev = state.history.at(-1);
  if (!prev) return state;
  return {
    ...state,
    tree: prev.tree,
    revision: prev.revision,
    // no arrival animation on back — it's a local view restore, not new content
    lastApply: null,
    history: state.history.slice(0, -1),
  };
}

export interface ApplyResult {
  state: CanvasState;
  /** true → the host must reconnect + re-handshake with the same canvasSessionId */
  resync: boolean;
}

const noticed = (state: CanvasState, notice: string): CanvasState => ({
  ...state,
  notices: [...state.notices.slice(-19), notice],
});

function applySurfaceEvent(state: CanvasState, ev: SurfaceEvent, now: number): ApplyResult {
  const valid = validateSurfaceEvent(ev);
  if (!valid.ok) {
    return { state: noticed(state, `surface event rejected: ${valid.errors}`), resync: false };
  }
  // A surface_snapshot is a full authoritative replace and opens a fresh
  // per-turn surfaceSeq run (server resets seq to 0 each turn) — it must NOT
  // be gap-checked against the previous turn's seq, or the second turn's
  // snapshot is wrongly rejected. The gap check applies only to patches,
  // which must be contiguous within a snapshot's run.
  if (
    ev.type !== 'surface_snapshot' &&
    state.lastSurfaceSeq !== null &&
    ev.surfaceSeq !== state.lastSurfaceSeq + 1
  ) {
    return {
      state: noticed(state, `surfaceSeq gap (${state.lastSurfaceSeq} → ${ev.surfaceSeq})`),
      resync: true,
    };
  }
  const seen = { ...state, lastSurfaceSeq: ev.surfaceSeq };

  switch (ev.type) {
    case 'surface_snapshot': {
      const tree = ev['tree'];
      const treeValid = validateTree(tree);
      if (!treeValid.ok) {
        return { state: noticed(seen, `snapshot tree rejected: ${treeValid.errors}`), resync: false };
      }
      const revision = String(ev['producesRevision']);
      return {
        state: {
          ...seen,
          tree,
          revision,
          snapshotRevision: revision,
          // §6.1: snapshot arrival renders as a full-canvas crossfade
          lastApply: { kind: 'snapshot', revision, changedIds: [], rapid: false },
          patchTimes: [],
          // a replaced server-authoritative view becomes back-navigable
          history:
            state.tree !== null && state.revision !== null
              ? [...state.history.slice(-9), { tree: state.tree, revision: state.revision }]
              : state.history,
        },
        resync: false,
      };
    }
    case 'surface_patch': {
      if (state.revision === null || String(ev['basedOnRevision']) !== state.revision) {
        return { state: noticed(seen, 'patch basedOnRevision mismatch'), resync: true };
      }
      try {
        const patches = ev['patches'] as unknown[];
        const next = applyTreePatches(state.tree, patches);
        const treeValid = validateTree(next);
        if (!treeValid.ok) {
          return { state: noticed(seen, `post-patch tree invalid: ${treeValid.errors}`), resync: true };
        }
        const revision = String(ev['producesRevision']);
        // §3.5 rapid-stream detection: patch arrivals in a 1s sliding window
        const patchTimes = [...state.patchTimes.filter((t) => now - t < 1000), now];
        return {
          state: {
            ...seen,
            tree: next,
            revision,
            patchTimes,
            lastApply: {
              kind: 'patch',
              revision,
              changedIds: changedNodeIds(state.tree, patches),
              rapid: patchTimes.length > 5,
            },
          },
          resync: false,
        };
      } catch (err) {
        return {
          state: noticed(seen, `patch failed: ${err instanceof Error ? err.message : String(err)}`),
          resync: true,
        };
      }
    }
    case 'surface_error':
      return { state: noticed(seen, `surface_error: ${String(ev['message'])}`), resync: false };
    default:
      // data_ref_* / action_result / local_action / mutation_resolved:
      // not rendered in the M1 slice — record so nothing fails silently.
      return { state: noticed(seen, `unhandled ${ev.type}`), resync: false };
  }
}

export function applyServerMessage(
  state: CanvasState,
  msg: ServerMessage,
  now: number = Date.now(),
): ApplyResult {
  if (SURFACE_EVENT_TYPES.has(msg.type)) {
    return applySurfaceEvent(state, msg as SurfaceEvent, now);
  }
  switch (msg.type) {
    case 'agent_text_delta':
      return { state: { ...state, prose: state.prose + msg.text }, resync: false };
    case 'turn_complete':
      return {
        // revision === null → the tree is only the client-local pending
        // skeleton (no server snapshot arrived); drop it back to cold start
        // instead of leaving a forever-pulsing skeleton.
        state: {
          ...state,
          turnPending: false,
          turnError: null,
          ...(state.revision === null ? { tree: null } : {}),
        },
        resync: false,
      };
    case 'turn_error':
      return {
        state: {
          ...noticed(state, `turn_error: ${msg.message}`),
          turnPending: false,
          turnError: msg.message,
          ...(state.revision === null ? { tree: null } : {}),
        },
        resync: false,
      };
    default:
      return { state, resync: false }; // handshake frames are the socket layer's business
  }
}
