import { type PluginContext } from '@omadia/plugin-api';
import {
  CHAT_AGENT_SERVICE,
  type ChatAgent,
  type ChatAgentBundle,
  type ChatStreamEvent,
} from '@omadia/channel-sdk';

import { resolveCanvasAllowSets } from './canvasAllowSets.js';
import { CANVAS_CHAT_AGENT_SERVICE, DEFAULT_COMPOSITION_MODEL } from './canvasProtocol.js';
import { registerCanvasPublishTools } from './canvasPublishTools.js';
import { canvasRefreshStream } from './canvasRefresh.js';
import { createCanvasRuntime } from './canvasRuntime.js';
import { canvasTurnStream } from './canvasTurn.js';
import { createProvenanceStash } from './datasetRecipe.js';
import { createSessionSerializer } from './sessionSerializer.js';

/**
 * @omadia/ui-orchestrator — Omadia UI Tier-2 orchestrator (PR-9b-2).
 *
 * `kind: extension`. On activate it publishes the `canvasChatAgent` service —
 * the bundle a canvas channel reaches via `channel.dispatch_service` (PR-6).
 *
 * For a **canvas turn** (one that carries `input.canvasSessionId`) the agent now
 * runs the cheapest-class composition step before delegating:
 *
 *   1. **Skeleton-first** — `composeSkeleton` (cheapest fast-class model —
 *      `class:fast` by default, overridable via `ui_orchestrator_model`;
 *      validator-gated with one repair retry,
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
 * Landed (PR-9b-3): the per-`canvasSessionId` write mutex (serialises all
 * surface writes for one canvas), in-place action turns (the client's live tree
 * via `canvasState` → skeleton skipped, patched on top), and DataRef HMAC
 * sign+verify (see `dataRef.ts`). The boot-computed canvas-output allow-set is
 * effectively covered by capability autodiscovery (declare→resolve→derive); the
 * `canvas_output_tools` config field remains the operator override, deny-by-
 * default when unset. Still open: a token-validated bulk-data FETCH path (the
 * verify primitive is ready; the consumer endpoint is a later slice).
 */

// The public surface of this module predates the split into the files
// below — every symbol stays importable from `plugin.ts`.
export {
  CANVAS_CHAT_AGENT_SERVICE,
  CANVAS_TURN_DIRECTIVE,
  LEGACY_PLANS_PATH,
} from './canvasProtocol.js';
export {
  CANVAS_CHOICE_TOOL,
  CANVAS_LUMEN_TOOL,
  CANVAS_PUBLISH_TOOL,
  handleCanvasPublishChoice,
  handleCanvasPublishLumen,
  handleCanvasPublishRows,
  V4_RENDER_TOOL,
  type CanvasDatasetResolver,
} from './canvasPublishHandlers.js';
export { deriveDataRequirements } from './dataRequirements.js';
export {
  actionTargetRow,
  mentionsValue,
  targetRecordBlock,
  type TargetRecord,
} from './turnTargets.js';

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
  const { configuredCanvasOutputTools, canvasOutputTools, deterministicActionTools } =
    resolveCanvasAllowSets(ctx);

  // Register the producer tool in the orchestrator tool loop. The accessor is
  // typed required but absent in narrow test contexts; without it the canvas
  // still renders skeleton + prose, only the data path is unavailable.
  const toolsAccessor = ctx.tools as PluginContext['tools'] | undefined;
  // dataset provenance of datasetId publishes, read inside the turn by the
  // publish handler and consumed by synthesis (derived recipes)
  const publishProvenance = createProvenanceStash();
  const { disposeTool, disposeChoiceTool, disposeLumenTool } = registerCanvasPublishTools(
    ctx,
    toolsAccessor,
    publishProvenance,
  );
  const rt = createCanvasRuntime(ctx, {
    model,
    toolsAccessor,
    canvasOutputTools,
    deterministicActionTools,
    publishProvenance,
  });
  const { refreshRecipes } = rt;

  const resolveBase = (): ChatAgent | undefined =>
    ctx.services.get<ChatAgentBundle>(CHAT_AGENT_SERVICE)?.agent;
  const serializePerSession = createSessionSerializer();

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
      const sid = input.canvasSessionId;
      // Serialise all writes to a single canvas behind the per-session mutex.
      if (input.canvasRefresh) {
        const refresh = input.canvasRefresh;
        return serializePerSession(sid, async function* () {
          await refreshRecipes.load(sid);
          yield* canvasRefreshStream(rt, input, observer, base, sid, refresh);
        });
      }
      return serializePerSession(sid, async function* () {
        await refreshRecipes.load(sid);
        yield* canvasTurnStream(rt, input, observer, base, sid);
      });
    },
  };

  const dispose = ctx.services.provide(CANVAS_CHAT_AGENT_SERVICE, {
    agent: canvasAgent,
  } satisfies ChatAgentBundle);

  ctx.log(
    `[omadia-ui-orchestrator] published ${CANVAS_CHAT_AGENT_SERVICE} ` +
      `(composition model: ${model}; canvas-output tools: ${configuredCanvasOutputTools.size} configured + manifest-declared via canvasOutputRegistry)`,
  );

  return {
    async close(): Promise<void> {
      ctx.log('deactivating omadia-ui-orchestrator');
      disposeTool?.();
      disposeChoiceTool?.();
      disposeLumenTool?.();
      dispose();
    },
  };
}

/** Stream yielded when no base orchestrator is registered (graceful degrade). */
async function* errorStream(): AsyncGenerator<ChatStreamEvent> {
  yield { type: 'error', message: 'orchestrator unavailable' };
}
