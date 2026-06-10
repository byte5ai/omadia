import type { PluginContext } from '@omadia/plugin-api';
import {
  CHAT_AGENT_SERVICE,
  type ChatAgent,
  type ChatAgentBundle,
  type ChatStreamEvent,
  type ChatTurnInput,
  type RevisionId,
} from '@omadia/channel-sdk';

import { composeSkeleton, type CompositionLlm } from './composition.js';
import { synthesizeSurfaceEvents } from './surfaceSynthesis.js';

/**
 * @omadia/ui-orchestrator — Omadia UI Tier-2 orchestrator (PR-9b-2).
 *
 * `kind: extension`. On activate it publishes the `canvasChatAgent` service —
 * the bundle a canvas channel reaches via `channel.dispatch_service` (PR-6).
 *
 * For a **canvas turn** (one that carries `input.canvasSessionId`) the agent now
 * runs the Haiku composition step before delegating:
 *
 *   1. **Skeleton-first** — `composeSkeleton` (fast model from
 *      `ui_orchestrator_model`, validator-gated with one repair retry,
 *      deterministic fallback) yields a `surface_snapshot` (revision "0")
 *      BEFORE the slow main turn starts.
 *   2. **Requirement handoff** — the delegated main turn's user message carries
 *      a `[canvas-context]` block with the skeleton's `dataRequirements`, so
 *      Tier-3 sub-agents return `_pendingStructuredPayload`s matching exactly
 *      the promised containerIds + fieldKeys.
 *   3. **Synthesis** — the base stream is wrapped in
 *      {@link synthesizeSurfaceEvents}, continuing seq/revision after the
 *      skeleton: authorised `_pendingCanvasTree` → `surface_snapshot`,
 *      `_pendingStructuredPayload` → deterministic `surface_patch`.
 *
 * Non-canvas turns (and the `chat()` path) pass straight through, byte-for-byte.
 * The base orchestrator tool loop is untouched.
 *
 * Still to land (later 9b slices): per-`canvasSessionId` write mutex +
 * cross-turn `surfaceSeq`/state persistence (PR-9b-3), DataRef HMAC signing,
 * the boot-computed canvas-output allow-set (PR-7b wiring — until then the
 * `canvas_output_tools` config field is the operator-managed interim allow-set,
 * deny-by-default when unset).
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
const DEFAULT_COMPOSITION_MODEL = 'claude-haiku-4-5';

export interface UiOrchestratorPluginHandle {
  close(): Promise<void>;
}

export async function activate(
  ctx: PluginContext,
): Promise<UiOrchestratorPluginHandle> {
  ctx.log('activating omadia-ui-orchestrator');

  // ctx.config / ctx.llm are optional-chained: real kernels always provide
  // config, but the accessors are absent in narrow test contexts and ctx.llm
  // is genuinely optional (no ANTHROPIC_API_KEY → composition falls back).
  const model =
    ctx.config?.get<string>('ui_orchestrator_model')?.trim() ||
    DEFAULT_COMPOSITION_MODEL;
  const canvasOutputTools: ReadonlySet<string> = new Set(
    (ctx.config?.get<string>('canvas_output_tools') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
  const llm: CompositionLlm = ctx.llm ?? {
    complete: () => Promise.reject(new Error('llm unavailable')),
  };

  const resolveBase = (): ChatAgent | undefined =>
    ctx.services.get<ChatAgentBundle>(CHAT_AGENT_SERVICE)?.agent;

  async function* canvasTurnStream(
    input: ChatTurnInput,
    observer: Parameters<ChatAgent['chatStream']>[1],
    base: ChatAgent,
    canvasSessionId: string,
  ): AsyncGenerator<ChatStreamEvent> {
    // 1. Skeleton-first — emitted BEFORE the (slow) main turn starts. Never
    //    throws: schema failure → bounded repair retry → deterministic fallback.
    const skeleton = await composeSkeleton({
      llm,
      model,
      userText: input.userMessage,
      log: (message) => ctx.log(message),
    });
    let surfaceSeq = 0;
    const initialRevision = '0' as RevisionId;
    yield {
      type: 'surface_snapshot',
      canvasSessionId,
      surfaceSeq: surfaceSeq++,
      producesRevision: initialRevision,
      tree: skeleton.tree,
      protocolVersion: CANVAS_PROTOCOL_VERSION,
      opsCatalogVersion: OPS_CATALOG_VERSION,
    };

    // 2. Requirement handoff — the main turn carries what the skeleton
    //    promised, so Tier 3 returns payloads matching those exact fields.
    const augmented: ChatTurnInput = {
      ...input,
      userMessage:
        input.userMessage +
        '\n\n[canvas-context]\n' +
        JSON.stringify({
          canvasSkeleton: { revision: initialRevision, source: skeleton.source },
          dataRequirements: skeleton.dataRequirements,
          instruction:
            'A canvas skeleton with the above data requirements is already ' +
            'rendered. Fetch and return the data matching exactly these ' +
            'containerIds and fieldKeys.',
        }),
    };

    // 3. Delegate + canvas-aware synthesis continuing seq/revision after the
    //    skeleton.
    yield* synthesizeSurfaceEvents(base.chatStream(augmented, observer), {
      canvasSessionId,
      authorizedToolNames: canvasOutputTools,
      protocolVersion: CANVAS_PROTOCOL_VERSION,
      opsCatalogVersion: OPS_CATALOG_VERSION,
      startSurfaceSeq: surfaceSeq,
      baseRevision: initialRevision,
      baseTree: skeleton.tree,
      dataRequirements: skeleton.dataRequirements,
    });
  }

  const canvasAgent: ChatAgent = {
    chat(input) {
      const base = resolveBase();
      if (!base) return Promise.reject(new Error('orchestrator unavailable'));
      return base.chat(input);
    },
    chatStream(input, observer) {
      const base = resolveBase();
      if (!base) return errorStream();
      // Only a canvas turn (channel-threaded canvasSessionId) gets composition
      // + surface synthesis; classic turns pass straight through, byte-for-byte.
      if (!input.canvasSessionId) return base.chatStream(input, observer);
      return canvasTurnStream(input, observer, base, input.canvasSessionId);
    },
  };

  const dispose = ctx.services.provide(CANVAS_CHAT_AGENT_SERVICE, {
    agent: canvasAgent,
  } satisfies ChatAgentBundle);

  ctx.log(
    `[omadia-ui-orchestrator] published ${CANVAS_CHAT_AGENT_SERVICE} ` +
      `(composition model: ${model}; canvas-output tools: ${canvasOutputTools.size})`,
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
