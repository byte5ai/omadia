import type { ChatStreamEvent, DataRef, RevisionId } from '@omadia/channel-sdk';
import {
  parseToolEmittedCanvasTree,
  parseToolEmittedStructuredPayload,
  parseToolEmittedSurfacePatch,
} from '@omadia/orchestrator';

import type { DataRequirement } from './composition.js';
import { composeStructuredPayloadPatch } from './patchComposition.js';

/**
 * Tier-2 surface synthesis (PR-9b-1, extended by PR-9b-2).
 *
 * The `canvasChatAgent` wraps the base orchestrator's event stream and turns it
 * canvas-aware: when an AUTHORISED tool returns a canvas sentinel, a surface
 * event is synthesised and injected into the stream; every other event passes
 * through unchanged. Pure transformer — no shared state, and the base
 * orchestrator tool loop is untouched.
 *
 *   - `_pendingCanvasTree`        → `surface_snapshot` (full tree replace)
 *   - `_pendingStructuredPayload` → `surface_patch` appending the payload rows
 *     onto the current tree (deterministic mapping against the skeleton's own
 *     columns — see patchComposition.ts; unmappable payloads are skipped, the
 *     data still reaches the user as prose)
 *
 * PR-9b-2 additions: `startSurfaceSeq`/`baseRevision`/`baseTree` let the
 * caller continue counters after an already-emitted skeleton snapshot
 * (plugin.ts emits revision "0" before delegating), and `dataRequirements`
 * carry the [canvas-context] contract for payload→table mapping.
 *
 * Still NOT here (later 9b slices): `surface_data_ref_created` (needs DataRef
 * HMAC signing); cross-turn `surfaceSeq` continuity + the per-canvasSession
 * write mutex (PR-9b-3) — `surfaceSeq` here is per-stream.
 */

export interface SurfaceSynthesisConfig {
  /** the canvas session this turn belongs to — stamped onto every surface event. */
  canvasSessionId: string;
  /**
   * Deny-by-default gate: only a tool result from a tool this lookup accepts
   * is scanned for canvas sentinels. Derived from manifest-declared
   * `canvas_output: true` capabilities (kernel `canvasOutputRegistry`,
   * resolved on plugin activation) plus the operator's `canvas_output_tools`
   * config override. A plain ReadonlySet<string> satisfies the shape (tests);
   * the plugin passes a lazy predicate so hot-installed plugins are
   * authorised without re-activation. Nothing accepted → nothing synthesised.
   */
  authorizedToolNames: { has(toolName: string): boolean };
  protocolVersion: string;
  opsCatalogVersion: string;
  /** continue after an already-emitted skeleton snapshot (default 0). */
  startSurfaceSeq?: number;
  /** revision of `baseTree` (v1: stringified monotonic int); patches build on it. */
  baseRevision?: RevisionId;
  /** the tree the next `surface_patch` is composed against (the skeleton). */
  baseTree?: unknown;
  /** the [canvas-context] requirement contract — payload→container mapping. */
  dataRequirements?: readonly DataRequirement[];
  /** observability: every skipped (unmappable) payload states why. */
  log?: (message: string) => void;
  /** deterministic refresh (omadia-ui#5): containers whose FIRST publish in
   *  this stream REPLACES the stale rows/points; follow-up batches append. */
  refreshContainers?: ReadonlySet<string>;
  /** recipe capture (omadia-ui#5, LLM-free refresh): called when a publish
   *  payload declares a `source` refresh recipe for its container — the
   *  caller persists it so a later canvas_refresh can re-execute the query
   *  without an LLM in the seat. May return a minted DataRef; the synthesis
   *  then announces it via `surface_data_ref_created` (refreshable flag)
   *  right after the corresponding patch. */
  onPublishedSource?: (containerId: string, source: unknown) => DataRef | undefined;
}

/**
 * Transform a base orchestrator `ChatStreamEvent` stream into a canvas-aware one.
 * Builds its own `tool_use.id → name` map (the `tool_result` event carries only
 * the id) so the gate can be enforced by tool name.
 */

/** JSON-Pointer path to the first node carrying `id`, or null. Generic walk:
 *  recurses every array element and nested object, so it finds nodes under
 *  children/container/tabs[].child/pane/form/toolbar uniformly. */
function findNodePath(node: unknown, id: string, base: string): string | null {
  if (node === null || typeof node !== 'object') return null;
  if ((node as { id?: unknown }).id === id) return base;
  for (const [key, value] of Object.entries(node)) {
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        const hit = findNodePath(value[i], id, `${base}/${key}/${i}`);
        if (hit !== null) return hit;
      }
    } else if (value !== null && typeof value === 'object') {
      const hit = findNodePath(value, id, `${base}/${key}`);
      if (hit !== null) return hit;
    }
  }
  return null;
}

/** Resolve a JSON-Pointer to the parent object + leaf key, creating nothing. */
function resolvePointer(
  root: unknown,
  pointer: string,
): { parent: Record<string, unknown>; key: string } | null {
  const parts = pointer.split('/').slice(1).map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'));
  const leaf = parts.pop();
  if (leaf === undefined) return null;
  let cur: unknown = root;
  for (const part of parts) {
    if (cur === null || typeof cur !== 'object') return null;
    cur = Array.isArray(cur) ? cur[Number(part)] : (cur as Record<string, unknown>)[part];
  }
  if (cur === null || typeof cur !== 'object' || Array.isArray(cur)) return null;
  return { parent: cur as Record<string, unknown>, key: leaf };
}

/** Apply an ID-addressed surface patch against a (deep-cloned) tree. Returns
 *  the next tree + the RFC-6902 ops that produced it, or null if no op mapped
 *  (every id missing). Unmappable ids are skipped (logged by the caller). */
function applySurfacePatch(
  tree: unknown,
  ops: { id: string; set: Record<string, unknown> }[],
  log?: (m: string) => void,
): { nextTree: unknown; patches: { op: 'add'; path: string; value: unknown }[] } | null {
  const next = structuredClone(tree);
  const patches: { op: 'add'; path: string; value: unknown }[] = [];
  for (const op of ops) {
    const nodePath = findNodePath(next, op.id, '');
    if (nodePath === null) {
      log?.(`[surface-synthesis] surface-patch UNMAPPABLE id=${op.id} (no node with that id)`);
      continue;
    }
    for (const [field, value] of Object.entries(op.set)) {
      const fieldPath = `${nodePath}/${field.replace(/~/g, '~0').replace(/\//g, '~1')}`;
      const target = resolvePointer(next, fieldPath);
      if (!target) continue;
      target.parent[target.key] = value;
      patches.push({ op: 'add', path: fieldPath, value });
    }
  }
  return patches.length > 0 ? { nextTree: next, patches } : null;
}

export async function* synthesizeSurfaceEvents(
  base: AsyncIterable<ChatStreamEvent>,
  config: SurfaceSynthesisConfig,
): AsyncGenerator<ChatStreamEvent> {
  const toolNameById = new Map<string, string>();
  // consumed set: patchComposition removes a container on its first publish
  const refreshContainers = new Set(config.refreshContainers ?? []);
  let surfaceSeq = config.startSurfaceSeq ?? 0;
  let revisionCounter =
    config.baseRevision !== undefined ? Number(config.baseRevision) + 1 : 0;
  let currentTree: unknown = config.baseTree;
  let currentRevision: RevisionId | undefined = config.baseRevision;

  // Scan one authorised tool result (top-level OR sub-agent) for canvas
  // sentinels and emit the corresponding surface events. Returns the events
  // to yield; an empty array means the result carried no sentinel. Sub-agent
  // tool results (`sub_tool_result`) reach here because the orchestrator
  // forwards inner sub-tool events into the main stream — an agent-kind
  // plugin's deterministic tree, emitted by a sub-tool like
  // `x_studio_show_wizard`, is otherwise buried inside the domain-tool result
  // and never synthesised.
  async function* handleAuthorisedResult(
    id: string,
    output: string,
  ): AsyncGenerator<ChatStreamEvent> {
    const name = toolNameById.get(id);
    if (name === undefined || !config.authorizedToolNames.has(name)) return;

    const parsedTree = parseToolEmittedCanvasTree(output);
    if (parsedTree) {
      const producesRevision = String(revisionCounter++) as RevisionId;
      currentTree = parsedTree.tree;
      currentRevision = producesRevision;
      yield {
        type: 'surface_snapshot',
        canvasSessionId: config.canvasSessionId,
        surfaceSeq: surfaceSeq++,
        producesRevision,
        tree: parsedTree.tree,
        protocolVersion: config.protocolVersion,
        opsCatalogVersion: config.opsCatalogVersion,
      };
      return;
    }

    if (currentTree === undefined || currentRevision === undefined) return;

    // ID-addressed surface patch (PR-9b-3): update existing nodes by stable id
    // without re-emitting the tree — the client patches in place (no remount).
    const surfacePatch = parseToolEmittedSurfacePatch(output);
    if (surfacePatch) {
      const applied = applySurfacePatch(currentTree, surfacePatch.ops, config.log);
      if (applied) {
        const producesRevision = String(revisionCounter++) as RevisionId;
        yield {
          type: 'surface_patch',
          canvasSessionId: config.canvasSessionId,
          surfaceSeq: surfaceSeq++,
          basedOnRevision: currentRevision,
          producesRevision,
          patches: applied.patches,
        };
        currentTree = applied.nextTree;
        currentRevision = producesRevision;
      }
      return;
    }

    const payload = parseToolEmittedStructuredPayload(output);
    if (!payload) return;
      // recipe capture happens regardless of compose success — a recipe for
      // a payload whose patch was skipped is still a valid refresh source
      let mintedRef: DataRef | undefined;
      if (config.onPublishedSource) {
        const d = payload.data as { containerId?: unknown; source?: unknown } | null;
        if (
          typeof d?.containerId === 'string' &&
          typeof d.source === 'object' &&
          d.source !== null
        ) {
          mintedRef = config.onPublishedSource(d.containerId, d.source);
        }
      }
      const composed = composeStructuredPayloadPatch({
        baseTree: currentTree,
        payload,
        dataRequirements: config.dataRequirements ?? [],
        ...(refreshContainers.size > 0 ? { refreshContainers } : {}),
        ...(config.log ? { log: config.log } : {}),
      });
      if (!composed) {
        // unmappable → skip; data still arrives as prose. Loud, because a
        // silently-dropped patch reads as "empty canvas" to the user.
        const dataInfo =
          typeof payload.data === 'object' && payload.data !== null
            ? `containerId=${String((payload.data as { containerId?: unknown }).containerId)} ` +
              `rows=${Array.isArray((payload.data as { rows?: unknown }).rows) ? ((payload.data as { rows: unknown[] }).rows.length) : 'n/a'}`
            : 'data=non-object';
        config.log?.(
          `[surface-synthesis] structured payload UNMAPPABLE (${dataInfo}; ` +
            `requirements=${(config.dataRequirements ?? []).map((r) => r.containerId).join(',')})`,
        );
        return;
      }
      const producesRevision = String(revisionCounter++) as RevisionId;
      yield {
        type: 'surface_patch',
        canvasSessionId: config.canvasSessionId,
        surfaceSeq: surfaceSeq++,
        basedOnRevision: currentRevision,
        producesRevision,
        patches: composed.patches,
      };
      currentTree = composed.nextTree;
      currentRevision = producesRevision;
      // announce the captured refresh recipe (9b-3 minimal slice): the ref
      // rides the SAME seq run right after its patch, at the new revision
      if (mintedRef) {
        yield {
          type: 'surface_data_ref_created',
          canvasSessionId: config.canvasSessionId,
          surfaceSeq: surfaceSeq++,
          revision: producesRevision,
          dataRef: mintedRef,
        };
      }
  }

  for await (const ev of base) {
    if (ev.type === 'tool_use') {
      toolNameById.set(ev.id, ev.name);
      yield ev;
      continue;
    }

    // Sub-agent inner tool calls — forwarded into the main stream by the
    // orchestrator. Map their names so an agent-kind plugin's sub-tool that
    // emits a canvas sentinel is synthesised exactly like a top-level tool.
    if (ev.type === 'sub_tool_use') {
      toolNameById.set(ev.id, ev.name);
      yield ev;
      continue;
    }

    if (ev.type === 'tool_result') {
      yield ev;
      yield* handleAuthorisedResult(ev.id, ev.output);
      continue;
    }

    if (ev.type === 'sub_tool_result') {
      yield ev;
      yield* handleAuthorisedResult(ev.id, ev.output);
      continue;
    }

    yield ev;
  }
}
