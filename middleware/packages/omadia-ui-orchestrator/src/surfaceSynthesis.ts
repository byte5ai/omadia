import type { ChatStreamEvent, RevisionId } from '@omadia/channel-sdk';
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
   * Deny-by-default gate: only a tool result from a tool in this set is scanned
   * for canvas sentinels. Populated from the plugin's `canvas_output_tools`
   * config (interim allow-set until the boot-computed canvas-output capability
   * wiring lands); empty → nothing is synthesised.
   */
  authorizedToolNames: ReadonlySet<string>;
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
      const composed = composeStructuredPayloadPatch({
        baseTree: currentTree,
        payload,
        dataRequirements: config.dataRequirements ?? [],
      });
      if (!composed) continue; // unmappable → skip; data still arrives as prose
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
      continue;
    }

    yield ev;
  }
}
