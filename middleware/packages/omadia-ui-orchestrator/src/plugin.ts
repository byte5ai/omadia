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

/** NativeToolHandler for {@link CANVAS_PUBLISH_TOOL}. Exported for tests.
 *  An EMPTY rows array is legitimate (the data set is genuinely empty) — the
 *  sentinel still resolves the skeleton's loading state client-side. */
export async function handleCanvasPublishRows(input: unknown): Promise<string> {
  const args = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
  const containerId = typeof args['containerId'] === 'string' ? args['containerId'].trim() : '';
  if (containerId.length === 0 || !Array.isArray(args['rows'])) {
    return 'Error: canvas_publish_rows requires a containerId and a rows array of objects (rows may be empty for an empty data set).';
  }
  const rows = args['rows'].filter(
    (r): r is Record<string, unknown> => typeof r === 'object' && r !== null && !Array.isArray(r),
  );
  // Optional agent-authored row context-menu entries for the published
  // container — the client renders them in the context-invoke panel instead
  // of its generic fallback. The agent knows the CURRENT view; the client
  // doesn't.
  const actions = (Array.isArray(args['actions']) ? args['actions'] : [])
    .filter(
      (a): a is Record<string, unknown> => typeof a === 'object' && a !== null && !Array.isArray(a),
    )
    .filter((a) => typeof a['label'] === 'string' && (a['label'] as string).trim().length > 0)
    .slice(0, 4)
    .map((a, i) => ({
      id: typeof a['id'] === 'string' && a['id'].length > 0 ? a['id'] : `act-${i}`,
      label: (a['label'] as string).trim(),
      ...(typeof a['prompt'] === 'string' && a['prompt'].trim().length > 0
        ? { prompt: a['prompt'].trim() }
        : {}),
    }));
  const prose =
    typeof args['prose'] === 'string' && args['prose'].trim().length > 0
      ? args['prose'].trim()
      : rows.length === 0
        ? `No rows for ${containerId} — the data set is empty.`
        : `Published ${rows.length} row(s) for ${containerId}.`;
  const chartType =
    args['chartType'] === 'bar' || args['chartType'] === 'line' || args['chartType'] === 'pie'
      ? args['chartType']
      : undefined;
  return JSON.stringify({
    _pendingStructuredPayload: {
      prose,
      dataRefId: randomUUID(),
      data: {
        containerId,
        rows,
        ...(actions.length > 0 ? { actions } : {}),
        ...(chartType ? { chartType } : {}),
      },
    },
  });
}

/** Tier-3 producer tool for runtime disambiguation: when the main turn finds
 *  SEVERAL plausible targets for the user's request, it publishes the
 *  alternatives as a `choice` element on the canvas instead of asking in
 *  prose. The pick comes back as the next turn's `action`. Always in the
 *  allow-set. */
export const CANVAS_CHOICE_TOOL = 'canvas_publish_choice';

/** NativeToolHandler for {@link CANVAS_CHOICE_TOOL}. Exported for tests. */
export async function handleCanvasPublishChoice(input: unknown): Promise<string> {
  const args = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
  const question = typeof args['question'] === 'string' ? args['question'].trim() : '';
  const options = (Array.isArray(args['options']) ? args['options'] : []).filter(
    (o): o is { value: string; label: string } =>
      typeof o === 'object' &&
      o !== null &&
      typeof (o as { value?: unknown }).value === 'string' &&
      typeof (o as { label?: unknown }).label === 'string',
  );
  if (question.length === 0 || options.length < 2) {
    return 'Error: canvas_publish_choice requires a question and at least two options of { value, label }.';
  }
  const containerId =
    typeof args['containerId'] === 'string' && args['containerId'].trim().length > 0
      ? args['containerId'].trim()
      : undefined;
  const prose =
    typeof args['prose'] === 'string' && args['prose'].trim().length > 0
      ? args['prose'].trim()
      : `Asked the user to pick one of ${options.length} options.`;
  return JSON.stringify({
    _pendingStructuredPayload: {
      prose,
      dataRefId: randomUUID(),
      data: {
        ...(containerId ? { containerId } : {}),
        choice: {
          question,
          ...(args['variant'] === 'dropdown' ? { variant: 'dropdown' } : {}),
          options: options.map((o) => ({ value: o.value, label: o.label })),
        },
      },
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
    CANVAS_CHOICE_TOOL,
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
        'message carries a [canvas-context] block: call it for each containerId from its ' +
        'dataRequirements, with rows keyed EXACTLY by the promised fieldKeys. Large data sets ' +
        'MUST go out in batches of at most 30 rows per call — repeated calls for the same ' +
        'containerId APPEND; make ONE call, wait for its result, then publish the next batch ' +
        'until every row is out (a single oversized call risks being truncated and dropped ' +
        'entirely). The rows render directly into the already-visible canvas table — do not ' +
        'repeat them as text afterwards.',
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
              'one object per row, AT MOST 30 rows per call (more rows → follow-up calls to the ' +
              'same containerId, they append); keys = the promised fieldKeys (optional rowKey/id ' +
              'for stable row identity). MAY be empty ([]) when the fetched data set is genuinely ' +
              'empty — the table then shows its empty state; never invent rows. For a CHART ' +
              'container, each row carries { label: string, value: number } — one row per data ' +
              'point.',
          },
          prose: {
            type: 'string',
            description: 'one short human sentence describing the published data',
          },
          chartType: {
            type: 'string',
            enum: ['bar', 'line', 'pie'],
            description:
              'when publishing to a CHART container: the chart kind that fits the fetched data ' +
              '(time series → line, category comparison → bar, share-of-whole → pie). Overrides ' +
              'the skeleton’s guess — YOU have seen the data, the skeleton hasn’t.',
          },
          actions: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'stable action id' },
                label: { type: 'string', description: 'menu entry, in the user’s language' },
                prompt: {
                  type: 'string',
                  description: 'beam text the click pre-fills (the row context is attached automatically)',
                },
              },
              required: ['label'],
            },
            description:
              '1–4 row context-menu entries that fit the CURRENT view and data (e.g. in a detail ' +
              'view: actions on the detail rows). NEVER an action that re-opens the view the user ' +
              'is already in. Omit to keep the client’s generic fallback.',
          },
        },
        required: ['containerId', 'rows'],
      },
    },
    handleCanvasPublishRows,
  );
  const disposeChoiceTool: (() => void) | undefined = toolsAccessor?.register(
    {
      name: CANVAS_CHOICE_TOOL,
      description:
        'Render a clickable choice on the Omadia UI canvas when the user request is AMBIGUOUS ' +
        '(several plausible records/interpretations match). Use ONLY when the user message ' +
        'carries a [canvas-context] block. Call it INSTEAD of asking back in prose; the pick ' +
        'arrives as the next turn. One option per alternative, values must be stable keys.',
      input_schema: {
        type: 'object',
        properties: {
          question: {
            type: 'string',
            description: 'the disambiguation question, in the user’s language',
          },
          options: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                value: { type: 'string', description: 'stable key (e.g. record id)' },
                label: { type: 'string', description: 'human-readable alternative' },
              },
              required: ['value', 'label'],
            },
            description: 'the alternatives (at least two)',
          },
          containerId: {
            type: 'string',
            description: 'optional canvas container to render into; defaults to the page root',
          },
          prose: {
            type: 'string',
            description: 'one short human sentence accompanying the question',
          },
        },
        required: ['question', 'options'],
      },
    },
    handleCanvasPublishChoice,
  );
  ctx.log(
    `[omadia-ui-orchestrator] producer tools ${CANVAS_PUBLISH_TOOL}+${CANVAS_CHOICE_TOOL} ${
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
    //    An action-only turn (choice pick, button click) has no text — the
    //    structured action then IS the request the skeleton is composed for.
    const skeleton = await composeSkeleton({
      llm,
      model,
      userText:
        input.userMessage.trim().length > 0
          ? input.userMessage
          : `UI action: ${JSON.stringify(input.action ?? {})}`,
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
    //    A structured UI action (choice pick, button click) is the user's
    //    ANSWER — handed to the main turn as a [canvas-action] block.
    const actionBlock = input.action
      ? '\n\n[canvas-action]\n' +
        JSON.stringify(input.action) +
        '\nThis structured UI action is the user’s input for this turn (a ' +
        'choice pick carries the chosen value in payload.value). Act on it ' +
        'directly — do not ask what the user meant.'
      : '';
    // A row-bound text turn (beam, context action) carries the TargetRef of
    // the record it refers to — the agent must act on THAT record, never ask.
    const targetBlock =
      !input.action && input.target !== undefined
        ? '\n\n[canvas-target]\n' +
          JSON.stringify(input.target) +
          '\nThe user’s message refers to EXACTLY this record on the canvas ' +
          '(stable ids: containerId/itemKey/rowKey). Act on it directly — ' +
          'do not ask which record was meant.'
        : '';
    const augmented: ChatTurnInput = {
      ...input,
      userMessage:
        input.userMessage +
        actionBlock +
        targetBlock +
        '\n\n[canvas-context]\n' +
        JSON.stringify({
          canvasSkeleton: { revision: initialRevision, source: skeleton.source },
          dataRequirements: skeleton.dataRequirements,
          instruction:
            'A canvas skeleton with the above data requirements is already ' +
            'rendered. Work silently: do NOT narrate planning, lookups, memory ' +
            'checks, or tool calls — the canvas is the output channel. Fetch ' +
            'the data, then call the canvas_publish_rows tool for each ' +
            'containerId with rows keyed EXACTLY by the promised fieldKeys. ' +
            'BATCH RULE: at most 30 rows per call — for larger sets publish ' +
            'batch after batch to the same containerId (calls append), one ' +
            'call at a time, until every row is out; NEVER pack the whole set ' +
            'into one giant call (it gets truncated and dropped). Publish ' +
            'rows: [] when the data set is genuinely empty (never invent ' +
            'rows). All published values are PLAIN TEXT — never ' +
            'markdown (**bold**, `code`, # headings); labels belong in ' +
            'columns, not inline markers. Pass 1–3 `actions` (row context-menu ' +
            'entries) that fit the CURRENT view, in the user’s language — ' +
            'never one that re-opens the current view. If the request is ' +
            'AMBIGUOUS (several plausible records match), call ' +
            'canvas_publish_choice with one option per alternative instead of ' +
            'asking back in prose. The published data renders into the visible ' +
            'canvas — after publishing, reply with ONE short summary sentence ' +
            'only and do NOT repeat the data as text or markdown tables.',
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
      log: (message) => ctx.log(message),
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
      disposeChoiceTool?.();
      dispose();
    },
  };
}

/** Stream yielded when no base orchestrator is registered (graceful degrade). */
async function* errorStream(): AsyncGenerator<ChatStreamEvent> {
  yield { type: 'error', message: 'orchestrator unavailable' };
}
