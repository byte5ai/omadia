import type { PluginContext } from '@omadia/plugin-api';
import {
  CHAT_AGENT_SERVICE,
  type ChatAgent,
  type ChatAgentBundle,
  type ChatStreamEvent,
} from '@omadia/channel-sdk';

import { synthesizeSurfaceEvents } from './surfaceSynthesis.js';

/**
 * @omadia/ui-orchestrator — Omadia UI Tier-2 orchestrator (PR-9b-1).
 *
 * `kind: extension`. On activate it publishes the `canvasChatAgent` service —
 * the bundle a canvas channel reaches via `channel.dispatch_service` (PR-6).
 *
 * `canvasChatAgent` resolves the base `chatAgent` lazily per call (so a
 * hot-reloaded orchestrator is always used) and, for a **canvas turn** (one that
 * carries `input.canvasSessionId`), wraps the base event stream in
 * {@link synthesizeSurfaceEvents}: an authorised tool's `_pendingCanvasTree`
 * sentinel becomes an injected `surface_snapshot`. Non-canvas turns (and the
 * `chat()` path) pass straight through. The base orchestrator tool loop is
 * untouched.
 *
 * Still to land (later 9b slices): the producer (a canvas-output tool / UI Skill
 * that actually emits the sentinel — until then the synthesiser is inert in
 * production), the boot-computed canvas-output allow-set wiring,
 * `_pendingStructuredPayload` → `surface_data_ref_created`, and the
 * per-`canvasSessionId` write mutex + cross-turn `surfaceSeq` continuity.
 */

/**
 * Bare service-registry key this plugin publishes under. BARE (no `@N`): the
 * registry looks up by exact string and does not strip a version suffix — the
 * `@1` lives only in the manifest `provides`. A canvas channel's
 * `dispatch_service` must carry this exact bare string.
 */
export const CANVAS_CHAT_AGENT_SERVICE = 'canvasChatAgent';

const CANVAS_PROTOCOL_VERSION = '1.0';
const OPS_CATALOG_VERSION = '1.0';

/**
 * Deny-by-default canvas-output allow-set. EMPTY until the boot-computed set of
 * canvas-output-authorised tools is wired alongside the first producer tool
 * (PR-9b-2); until then no tool is trusted to emit canvas sentinels, so the
 * synthesiser is correctly inert in production. The gate mechanism is live.
 */
const CANVAS_OUTPUT_TOOLS: ReadonlySet<string> = new Set<string>();

export interface UiOrchestratorPluginHandle {
  close(): Promise<void>;
}

export async function activate(
  ctx: PluginContext,
): Promise<UiOrchestratorPluginHandle> {
  ctx.log('activating omadia-ui-orchestrator (skeleton)');

  const resolveBase = (): ChatAgent | undefined =>
    ctx.services.get<ChatAgentBundle>(CHAT_AGENT_SERVICE)?.agent;

  const canvasAgent: ChatAgent = {
    chat(input) {
      const base = resolveBase();
      if (!base) return Promise.reject(new Error('orchestrator unavailable'));
      return base.chat(input);
    },
    chatStream(input, observer) {
      const base = resolveBase();
      if (!base) return errorStream();
      const stream = base.chatStream(input, observer);
      // Only a canvas turn (channel-threaded canvasSessionId) gets surface
      // synthesis; classic turns pass straight through, byte-for-byte.
      if (!input.canvasSessionId) return stream;
      return synthesizeSurfaceEvents(stream, {
        canvasSessionId: input.canvasSessionId,
        authorizedToolNames: CANVAS_OUTPUT_TOOLS,
        protocolVersion: CANVAS_PROTOCOL_VERSION,
        opsCatalogVersion: OPS_CATALOG_VERSION,
      });
    },
  };

  const dispose = ctx.services.provide(CANVAS_CHAT_AGENT_SERVICE, {
    agent: canvasAgent,
  } satisfies ChatAgentBundle);

  ctx.log(
    `[omadia-ui-orchestrator] published ${CANVAS_CHAT_AGENT_SERVICE} (delegating skeleton)`,
  );

  return {
    async close(): Promise<void> {
      ctx.log('deactivating omadia-ui-orchestrator');
      dispose();
    },
  };
}

/** Stream yielded when no base orchestrator is registered (graceful degrade). */
async function* errorStream(): AsyncGenerator<ChatStreamEvent> {
  yield { type: 'error', message: 'orchestrator unavailable' };
}
