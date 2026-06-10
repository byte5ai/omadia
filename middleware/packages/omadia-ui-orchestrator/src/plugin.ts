import { randomUUID } from 'node:crypto';

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

/** Tier-3 producer tool — the first consumer of the canvas-output path. The
 *  [canvas-context] handoff instructs the main turn to publish fetched rows
 *  through this tool; its result string carries the
 *  `_pendingStructuredPayload` sentinel that surface synthesis maps onto the
 *  skeleton as a deterministic `surface_patch`. Always in the allow-set. */
export const CANVAS_PUBLISH_TOOL = 'canvas_publish_rows';

/** NativeToolHandler for {@link CANVAS_PUBLISH_TOOL}. Exported for tests. */
export async function handleCanvasPublishRows(input: unknown): Promise<string> {
  const args = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
  const containerId = typeof args['containerId'] === 'string' ? args['containerId'].trim() : '';
  const rows = Array.isArray(args['rows'])
    ? args['rows'].filter(
        (r): r is Record<string, unknown> => typeof r === 'object' && r !== null && !Array.isArray(r),
      )
    : [];
  if (containerId.length === 0 || rows.length === 0) {
    return 'Error: canvas_publish_rows requires a containerId and a non-empty rows array of objects.';
  }
  const prose =
    typeof args['prose'] === 'string' && args['prose'].trim().length > 0
      ? args['prose'].trim()
      : `Published ${rows.length} row(s) for ${containerId}.`;
  return JSON.stringify({
    _pendingStructuredPayload: {
      prose,
      dataRefId: randomUUID(),
      data: { containerId, rows },
    },
  });
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
  // Our own producer tool is always authorised; the operator config extends
  // the allow-set with additional sentinel-emitting tools.
  const canvasOutputTools: ReadonlySet<string> = new Set([
    CANVAS_PUBLISH_TOOL,
    ...(ctx.config?.get<string>('canvas_output_tools') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  ]);

  // Register the producer tool in the orchestrator tool loop. The accessor is
  // typed required but absent in narrow test contexts; without it the canvas
  // still renders skeleton + prose, only the data path is unavailable.
  const toolsAccessor = ctx.tools as PluginContext['tools'] | undefined;
  const disposeTool: (() => void) | undefined = toolsAccessor?.register(
    {
      name: CANVAS_PUBLISH_TOOL,
      description:
        'Publish fetched data rows for an Omadia UI canvas container. Use ONLY when the user ' +
        'message carries a [canvas-context] block: call once per containerId from its ' +
        'dataRequirements, with rows keyed EXACTLY by the promised fieldKeys. The rows render ' +
        'directly into the already-visible canvas table — do not repeat them as text afterwards.',
      input_schema: {
        type: 'object',
        properties: {
          containerId: {
            type: 'string',
            description: 'containerId from the [canvas-context] dataRequirements',
          },
          rows: {
            type: 'array',
            items: { type: 'object' },
            description:
              'one object per row; keys = the promised fieldKeys (optional rowKey/id for stable row identity)',
          },
          prose: {
            type: 'string',
            description: 'one short human sentence describing the published data',
          },
        },
        required: ['containerId', 'rows'],
      },
    },
    handleCanvasPublishRows,
  );
  ctx.log(
    `[omadia-ui-orchestrator] producer tool ${CANVAS_PUBLISH_TOOL} ${
      disposeTool ? 'registered' : 'NOT registered (no tools accessor in this context)'
    }`,
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
            'rendered. Fetch the data, then call the canvas_publish_rows tool ' +
            'once per containerId with rows keyed EXACTLY by the promised ' +
            'fieldKeys. The rows render into the visible canvas table — after ' +
            'publishing, reply with one short summary sentence only and do NOT ' +
            'repeat the rows as text or markdown tables.',
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
      disposeTool?.();
      dispose();
    },
  };
}

/** Stream yielded when no base orchestrator is registered (graceful degrade). */
async function* errorStream(): AsyncGenerator<ChatStreamEvent> {
  yield { type: 'error', message: 'orchestrator unavailable' };
}
