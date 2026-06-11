import type { ChatStreamEvent, DataRef, RevisionId } from '@omadia/channel-sdk';
import {
  parseToolEmittedCanvasTree,
  parseToolEmittedStructuredPayload,
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

  for await (const ev of base) {
    if (ev.type === 'tool_use') {
      toolNameById.set(ev.id, ev.name);
      yield ev;
      continue;
    }

    if (ev.type === 'tool_result') {
      yield ev;
      const name = toolNameById.get(ev.id);
      if (name === undefined || !config.authorizedToolNames.has(name)) continue;

      const parsedTree = parseToolEmittedCanvasTree(ev.output);
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
        continue;
      }

      if (currentTree === undefined || currentRevision === undefined) continue;
      const payload = parseToolEmittedStructuredPayload(ev.output);
      if (!payload) continue;
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
        continue;
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
      continue;
    }

    yield ev;
  }
}
