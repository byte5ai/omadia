import type { ChatStreamEvent, RevisionId } from '@omadia/channel-sdk';
import { parseToolEmittedCanvasTree } from '@omadia/orchestrator';

/**
 * Tier-2 surface synthesis (PR-9b-1).
 *
 * The `canvasChatAgent` wraps the base orchestrator's event stream and turns it
 * canvas-aware: when an AUTHORISED tool returns a `_pendingCanvasTree` sentinel
 * (#169 parser), a `surface_snapshot` event is synthesised and injected into the
 * stream; every other event passes through unchanged. Pure transformer — no
 * shared state, and the base orchestrator tool loop is untouched.
 *
 * What is intentionally NOT here yet (later 9b slices):
 *   - the producer: no tool emits `_pendingCanvasTree` today, so in production
 *     this is inert until PR-9b-2 ships a canvas-output tool / UI Skill;
 *   - `_pendingStructuredPayload` → `surface_data_ref_created` (needs DataRef
 *     HMAC signing);
 *   - cross-turn `surfaceSeq` continuity + the per-canvasSession write mutex
 *     (PR-9b-3) — `surfaceSeq` here is per-stream.
 */

export interface SurfaceSynthesisConfig {
  /** the canvas session this turn belongs to — stamped onto every surface event. */
  canvasSessionId: string;
  /**
   * Deny-by-default gate: only a tool result from a tool in this set is scanned
   * for canvas sentinels. EMPTY until the boot-computed canvas-output allow-set
   * is wired alongside the first producer tool (PR-9b-2), so in production today
   * nothing is synthesised — the correct secure-by-construction default. The
   * gate mechanism itself is live and tested.
   */
  authorizedToolNames: ReadonlySet<string>;
  protocolVersion: string;
  opsCatalogVersion: string;
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
  let surfaceSeq = 0;
  let revision = 0;

  for await (const ev of base) {
    if (ev.type === 'tool_use') {
      toolNameById.set(ev.id, ev.name);
      yield ev;
      continue;
    }

    if (ev.type === 'tool_result') {
      yield ev;
      const name = toolNameById.get(ev.id);
      if (name !== undefined && config.authorizedToolNames.has(name)) {
        const parsed = parseToolEmittedCanvasTree(ev.output);
        if (parsed) {
          const snapshot: ChatStreamEvent = {
            type: 'surface_snapshot',
            canvasSessionId: config.canvasSessionId,
            surfaceSeq: surfaceSeq++,
            producesRevision: String(revision++) as RevisionId,
            tree: parsed.tree,
            protocolVersion: config.protocolVersion,
            opsCatalogVersion: config.opsCatalogVersion,
          };
          yield snapshot;
        }
      }
      continue;
    }

    yield ev;
  }
}
