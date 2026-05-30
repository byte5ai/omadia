import type { PluginContext } from '@omadia/plugin-api';
import {
  CHAT_AGENT_SERVICE,
  type ChatAgent,
  type ChatAgentBundle,
  type ChatStreamEvent,
} from '@omadia/channel-sdk';

/**
 * @omadia/ui-orchestrator — Omadia UI Tier-2 orchestrator, skeleton (PR-9a).
 *
 * `kind: extension`. On activate it publishes the `canvasChatAgent` service —
 * the bundle a canvas channel reaches via `channel.dispatch_service` (PR-6).
 *
 * v0 is a thin DELEGATING skeleton: `canvasChatAgent` forwards `chat` /
 * `chatStream` to the base `chatAgent`, resolved lazily per call so a
 * hot-reloaded orchestrator is always used. This is the integration seam where
 * the real canvas work lands in follow-ups — the UI Skill (composition-idiom
 * library), `surface_*` synthesis, the per-`canvasSessionId` mutex, the data
 * cache, and the deferred wiring (PR-7b sentinel gating, `writeCapabilities`
 * attachment, `structured` threading). It does NOT yet synthesise any canvas
 * surface; routing a canvas channel to it today yields plain chat behaviour.
 */

/**
 * Bare service-registry key this plugin publishes under. BARE (no `@N`): the
 * registry looks up by exact string and does not strip a version suffix — the
 * `@1` lives only in the manifest `provides`. A canvas channel's
 * `dispatch_service` must carry this exact bare string.
 */
export const CANVAS_CHAT_AGENT_SERVICE = 'canvasChatAgent';

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
      return base.chatStream(input, observer);
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
