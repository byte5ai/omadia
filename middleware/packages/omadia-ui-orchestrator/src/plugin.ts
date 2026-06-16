import { randomUUID } from 'node:crypto';

import {
  PRIVACY_REDACT_SERVICE_NAME,
  type PluginContext,
  type PrivacyGuardService,
  type PrivacyResolvedDataset,
} from '@omadia/plugin-api';
import {
  CHAT_AGENT_SERVICE,
  type ChatAgent,
  type ChatAgentBundle,
  type ChatStreamEvent,
  type ChatTurnInput,
  type RevisionId,
} from '@omadia/channel-sdk';
import { today, turnContext } from '@omadia/orchestrator';

import { composeSkeleton, type CompositionLlm, type DataRequirement } from './composition.js';
import { mintDataRef } from './dataRef.js';
import {
  applyRefreshSource,
  createRecipeStore,
  parseRefreshSource,
} from './refreshRecipes.js';
import { synthesizeSurfaceEvents } from './surfaceSynthesis.js';
import { resolveReferenceLumen } from './referenceLumens.js';
import { validateLumenNode } from './treeValidator.js';
import { buildDatasetLumen } from './datasetLumen.js';

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

/**
 * Bare service-registry key this plugin publishes under. BARE (no `@N`): the
 * registry looks up by exact string and does not strip a version suffix — the
 * `@1` lives only in the manifest `provides`. A canvas channel's
 * `dispatch_service` must carry this exact bare string.
 */
export const CANVAS_CHAT_AGENT_SERVICE = 'canvasChatAgent';

const CANVAS_PROTOCOL_VERSION = '1.0';
const OPS_CATALOG_VERSION = '1.0';
// Skeleton composition is a low-stakes structural placeholder, so it ALWAYS
// runs on the cheapest tier — the `class:fast` ref resolves (in createLlmAccessor)
// to the active provider's fast/cheapest model: anthropic→claude-haiku, openai→
// gpt-5.4-mini, mistral→mistral-small. Provider-agnostic: pin a concrete id or a
// bigger class via the `ui_orchestrator_model` config only if the tree-validity
// gate (<95% first-attempt schema-valid) demands it.
const DEFAULT_COMPOSITION_MODEL = 'class:fast';

export interface UiOrchestratorPluginHandle {
  close(): Promise<void>;
}

/** Tier-3 producer tool — the first consumer of the canvas-output path. The
 *  [canvas-context] handoff instructs the main turn to publish fetched rows
 *  through this tool; its result string carries the
 *  `_pendingStructuredPayload` sentinel that surface synthesis maps onto the
 *  skeleton as a deterministic `surface_patch`. Always in the allow-set. */
export const CANVAS_PUBLISH_TOOL = 'canvas_publish_rows';

/** Resolves a privacy-shield datasetId to its real rows within the current
 *  turn. Returns `'unavailable'` when no privacy provider with dataset
 *  support is active (or no turn context exists), `undefined` for an
 *  unknown/expired id. Mirrors the office plugin's adapter pattern. */
export type CanvasDatasetResolver = (
  datasetId: string,
) => PrivacyResolvedDataset | 'unavailable' | undefined;

/** Privacy Shield v4: a dataset reference the LLM mistakenly wrapped INTO the
 *  rows array instead of passing `datasetId` top-level. Detecting it turns a
 *  silent one-garbage-row publish into a self-correcting tool error. */
const looksLikeDatasetRef = (rows: ReadonlyArray<Record<string, unknown>>): boolean =>
  rows.length === 1 &&
  rows[0] !== undefined &&
  Object.keys(rows[0]).length === 1 &&
  (typeof rows[0]['datasetId'] === 'string' ||
    Object.values(rows[0]).some((v) => typeof v === 'string' && /^ds_[0-9a-f-]{8,}$/i.test(v)));

/** Hard cap for dataset publishes — the canvas viewState budget is finite;
 *  bigger sets belong in a file (create_xlsx) or a filtered view. */
const MAX_DATASET_PUBLISH_ROWS = 500;

/** Install the canvas sentinel tap and return the FIFO lookup for
 *  `synthesizeSurfaceEvents`. On privacy-guard servers every tool result
 *  reaching the stream is the interned digest — the guard's dispatch sites
 *  hand the RAW sentinel-bearing result to this sink BEFORE interning, so
 *  synthesis composes from ground truth (incl. server-side resolved dataset
 *  rows the LLM never sees). The sink is set on the CURRENT (outer) scope —
 *  the orchestrator's turn scope carries it inward (same merge contract as
 *  `captureRawToolResult`); when no scope exists yet (canvas channel
 *  dispatch), one is entered with placeholder identity, exactly like
 *  `withChatParticipants` does for Teams. Guard-less servers never call the
 *  sink and the lookup stays empty — behaviour is unchanged there. */
function tapCanvasSentinels(log?: (m: string) => void): (toolName: string) => string | undefined {
  const queues = new Map<string, string[]>();
  const sink = (toolName: string, raw: string): void => {
    log?.(`[ui-orchestrator] sentinel tapped tool=${toolName} bytes=${raw.length}`);
    const q = queues.get(toolName);
    if (q) q.push(raw);
    else queues.set(toolName, [raw]);
  };
  const t = turnContext.current();
  if (t !== undefined) {
    t.canvasSentinelSink = sink;
  } else {
    turnContext.enter({ turnId: '', turnDate: today(), canvasSentinelSink: sink });
  }
  return (toolName) => queues.get(toolName)?.shift();
}

/** NativeToolHandler for {@link CANVAS_PUBLISH_TOOL}. Exported for tests.
 *  Accepts EITHER `rows` (tabular → table/chart) OR `fields` (a flat scalar
 *  object → a KPI/score container) OR `datasetId` (a privacy-shield dataset
 *  interned THIS turn — the real rows are resolved SERVER-SIDE and never pass
 *  through the LLM; the canvas patch is user-destined egress of the same
 *  trust class as a rendered answer or a generated file). An EMPTY rows array
 *  is legitimate (the data set is genuinely empty) — the sentinel still
 *  resolves the skeleton's loading state client-side. */
export async function handleCanvasPublishRows(
  input: unknown,
  resolveDataset?: CanvasDatasetResolver,
): Promise<string> {
  const args = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
  const containerId = typeof args['containerId'] === 'string' ? args['containerId'].trim() : '';
  const hasRows = Array.isArray(args['rows']);
  const fieldsRaw = args['fields'];
  const hasFields =
    typeof fieldsRaw === 'object' && fieldsRaw !== null && !Array.isArray(fieldsRaw);
  const datasetId =
    typeof args['datasetId'] === 'string' && args['datasetId'].trim().length > 0
      ? args['datasetId'].trim()
      : undefined;
  if (containerId.length === 0 || (!hasRows && !hasFields && datasetId === undefined)) {
    return (
      'Error: canvas_publish_rows requires a containerId and EITHER a rows array of objects ' +
      '(tabular data → table/chart; may be empty for an empty data set) OR a fields object ' +
      '{ fieldKey: value } of named scalar values (KPI/score container) OR a datasetId ' +
      '(privacy-shield dataset from THIS turn — rows resolve server-side).'
    );
  }
  if (datasetId !== undefined && (hasRows || hasFields)) {
    return (
      'Error: canvas_publish_rows takes EITHER datasetId OR rows/fields — not both. ' +
      'For shielded data pass ONLY the datasetId (shape it first with v4_select/v4_sort if needed).'
    );
  }
  let rows = hasRows
    ? (args['rows'] as unknown[]).filter(
        (r): r is Record<string, unknown> => typeof r === 'object' && r !== null && !Array.isArray(r),
      )
    : [];
  if (datasetId === undefined && hasRows && looksLikeDatasetRef(rows)) {
    return (
      'Error: that rows array contains a dataset REFERENCE, not data. Pass the id as the ' +
      'top-level `datasetId` parameter instead — the server resolves the real (masked) rows ' +
      'into the canvas. Do NOT retype masked values as rows.'
    );
  }
  let truncatedFrom: number | undefined;
  if (datasetId !== undefined) {
    const resolved = resolveDataset === undefined ? 'unavailable' : resolveDataset(datasetId);
    if (resolved === 'unavailable') {
      return (
        'Error: dataset publishing is unavailable on this server (no privacy provider with ' +
        'dataset support active). Publish concrete rows instead.'
      );
    }
    if (resolved === undefined) {
      return (
        `Error: unknown or expired datasetId "${datasetId}". Dataset ids are only valid within ` +
        'the turn that interned them — re-run the data tool and publish in the SAME turn.'
      );
    }
    rows = resolved.rows.map((r) => ({ ...r }));
    if (rows.length > MAX_DATASET_PUBLISH_ROWS) {
      truncatedFrom = rows.length;
      rows = rows.slice(0, MAX_DATASET_PUBLISH_ROWS);
    }
  }
  // Scalar/KPI payload: keep only scalar values (strings/numbers/booleans).
  const fields = hasFields
    ? Object.fromEntries(
        Object.entries(fieldsRaw as Record<string, unknown>).filter(
          ([, v]) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean',
        ),
      )
    : undefined;
  const hasMappableFields = fields !== undefined && Object.keys(fields).length > 0;
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
      : hasMappableFields
        ? `Published ${Object.keys(fields as object).length} field(s) for ${containerId}.`
        : rows.length === 0
          ? `No rows for ${containerId} — the data set is empty.`
          : datasetId !== undefined
            ? `Published ${rows.length} row(s) from dataset ${datasetId} for ${containerId}.` +
              (truncatedFrom !== undefined
                ? ` Truncated from ${truncatedFrom} rows — use a file export for the full set.`
                : '')
            : `Published ${rows.length} row(s) for ${containerId}.`;
  const chartType =
    args['chartType'] === 'bar' || args['chartType'] === 'line' || args['chartType'] === 'pie'
      ? args['chartType']
      : undefined;
  // refresh recipe (omadia-ui#5 phase 2) — threaded through the sentinel for
  // the synthesis layer's recipe capture (whitelist-validated there); stays
  // server-side, patches never carry it to the client
  const source =
    typeof args['source'] === 'object' && args['source'] !== null ? args['source'] : undefined;
  return JSON.stringify({
    _pendingStructuredPayload: {
      prose,
      dataRefId: randomUUID(),
      data: {
        containerId,
        // A fields publish targets a scalar/KPI container; omit `rows` so the
        // synthesis layer routes it through the fields branch, not the table one.
        ...(hasMappableFields ? { fields } : { rows }),
        ...(source ? { source } : {}),
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

// omadia-canvas-protocol/1.1 — Lumens (Live Interactivity) producer tool.
export const CANVAS_LUMEN_TOOL = 'canvas_publish_lumen';

/** NativeToolHandler for {@link CANVAS_LUMEN_TOOL}. Three paths, in order:
 *   - DATA-BOUND: the agent passes a privacy-shield `datasetId` (from a data tool
 *     THIS turn). The real rows resolve SERVER-SIDE (never through the LLM — so
 *     shielded data stays masked to the model) and an interactive data Lumen is
 *     built deterministically here. This is the L5 "loadData" pattern.
 *   - AUTHORED: the agent passes a full `lumen` it wrote → hard-validated
 *     (validateLumenNode); invalid → actionable error so it self-corrects. This is
 *     what makes LLM-generated interactivity SAFE: the model proposes declarative
 *     data, the host PROVES it bounded/total/deterministic before it ever runs.
 *   - PRESET (fallback): neither → a vetted reference by `variant`.
 *  The valid Lumen is emitted as a full-tree `_pendingCanvasTree` snapshot. */
export async function handleCanvasPublishLumen(
  input: unknown,
  resolveDataset?: CanvasDatasetResolver,
): Promise<string> {
  const args = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
  let lumen: Record<string, unknown>;
  let title = typeof args['title'] === 'string' && args['title'].trim().length > 0 ? args['title'].trim() : '';
  let hint: string | undefined;

  const datasetId =
    typeof args['datasetId'] === 'string' && args['datasetId'].trim().length > 0 ? args['datasetId'].trim() : undefined;
  const authored = args['lumen'];

  if (datasetId !== undefined) {
    const resolved = resolveDataset === undefined ? 'unavailable' : resolveDataset(datasetId);
    if (resolved === 'unavailable') {
      return (
        'Error: dataset-bound Lumens are unavailable on this server (no privacy provider with dataset ' +
        'support active). Author a `lumen` directly instead.'
      );
    }
    if (resolved === undefined) {
      return (
        `Error: unknown or expired datasetId "${datasetId}" — dataset ids are only valid within the turn ` +
        'that interned them; re-run the data tool and publish in the SAME turn.'
      );
    }
    const labelField = typeof args['labelField'] === 'string' ? args['labelField'] : undefined;
    const valueField = typeof args['valueField'] === 'string' ? args['valueField'] : undefined;
    lumen = buildDatasetLumen(
      resolved.rows.map((r) => ({ ...r })),
      { labelField, valueField },
    );
    if (title === '') title = 'Live Interactivity — Data Lumen';
  } else if (authored && typeof authored === 'object' && !Array.isArray(authored)) {
    const verdict = validateLumenNode(authored);
    if (!verdict.ok) {
      return (
        `Error: the authored Lumen is invalid and was NOT published — ${verdict.errors ?? 'unknown error'}. ` +
        'A Lumen is declarative DATA: { type:"lumen", id, state, transitions, view, events }. ' +
        'state leaves are typed + bounded; transitions are pure LX returning a new state via ' +
        '{ set:{ path: expr } }; view is an LX expression returning a primitive/scene tree; every ' +
        'event.run must name a declared transition. Fix the reported issue and call the tool again.'
      );
    }
    lumen = authored as Record<string, unknown>;
    if (title === '') title = 'Live Interactivity — Lumen';
  } else {
    const ref = resolveReferenceLumen(args['variant']);
    lumen = ref.lumen;
    if (title === '') title = ref.title;
    hint = ref.hint;
  }
  const tree = {
    type: 'container',
    id: 'lumen-demo',
    layout: 'stack',
    title,
    children: [
      { type: 'heading', id: 'lumen-demo-h', level: 2, content: title },
      ...(hint ? [{ type: 'text', id: 'lumen-demo-hint', content: hint }] : []),
      lumen,
    ],
  };
  // The sentinel shape parseToolEmittedCanvasTree expects is
  // { _pendingCanvasTree: { tree } } — the tree wrapped under a `tree` key.
  return JSON.stringify({ _pendingCanvasTree: { tree } });
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
  // Our own producer tools are always authorised; the operator config extends
  // the allow-set with additional sentinel-emitting tools (override path).
  const configuredCanvasOutputTools: ReadonlySet<string> = new Set([
    CANVAS_PUBLISH_TOOL,
    CANVAS_CHOICE_TOOL,
    CANVAS_LUMEN_TOOL,
    ...(ctx.config?.get<string>('canvas_output_tools') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  ]);
  // Canvas-output autodiscovery (declare → resolve → derive): plugins declare
  // `canvas_output: true` per manifest capability; the kernel resolves those
  // into the `canvasOutputRegistry` service as plugins (de)activate. The
  // lookup is LAZY per check — a plugin installed after this activation is
  // authorised without re-activating the orchestrator. Deny-by-default is
  // unchanged: no declaration + no config entry → sentinel ignored.
  const canvasOutputTools: { has(name: string): boolean } = {
    has: (name: string): boolean =>
      configuredCanvasOutputTools.has(name) ||
      ctx.services
        ?.get<{ has(name: string): boolean }>('canvasOutputRegistry')
        ?.has(name) === true,
  };

  // Deterministic-action allow-set (declare → resolve → derive, same shape as
  // canvas-output): a tool listed here owns a FULLY plugin-determined result —
  // a structured UI action whose `type` names it is dispatched DIRECTLY (no
  // model turn), its `_pendingCanvasTree`/`_pendingSurfacePatch` sentinel
  // synthesised straight into surface events. This is the "the application
  // layer already has this value, don't spend an LLM turn" path: saved-page
  // recalls, status flips, list views. Deny-by-default — a tool not declared
  // here still goes through the agent loop. Operator override via the
  // `deterministic_action_tools` config field; `deterministicActionRegistry`
  // is the forward-compat manifest-autodiscovery hook (absent today = no-op).
  const configuredDeterministicActionTools: ReadonlySet<string> = new Set([
    // A Lumen publish is fully plugin-determined (no data/LLM needed) — when a
    // canvas action names it, dispatch it DIRECTLY so a click renders the Lumen
    // with no model turn (also sidesteps LLM tool-call reliability).
    CANVAS_LUMEN_TOOL,
    ...(ctx.config?.get<string>('deterministic_action_tools') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  ]);
  const deterministicActionTools: { has(name: string): boolean } = {
    has: (name: string): boolean =>
      configuredDeterministicActionTools.has(name) ||
      ctx.services
        ?.get<{ has(name: string): boolean }>('deterministicActionRegistry')
        ?.has(name) === true,
  };

  // Register the producer tool in the orchestrator tool loop. The accessor is
  // typed required but absent in narrow test contexts; without it the canvas
  // still renders skeleton + prose, only the data path is unavailable.
  const toolsAccessor = ctx.tools as PluginContext['tools'] | undefined;
  const disposeTool: (() => void) | undefined = toolsAccessor?.register(
    {
      name: CANVAS_PUBLISH_TOOL,
      description:
        'Publish fetched data for an Omadia UI canvas container. Use ONLY when the user ' +
        'message carries a [canvas-context] block: call it for each containerId from its ' +
        'dataRequirements. THREE shapes — pick by what you hold: ' +
        '(1) TABULAR containers (a row per record) → pass `rows` keyed EXACTLY by the promised ' +
        'fieldKeys; large sets go out in batches of at most 30 rows per call (repeated calls ' +
        'for the same containerId APPEND — one call at a time until every row is out; a single ' +
        'oversized call risks being truncated and dropped). (2) SCALAR/KPI containers (named ' +
        'single values, e.g. a score block) → pass `fields` as a { fieldKey: value } object ' +
        'instead of rows. (3) PRIVACY-SHIELD datasets (a tool returned a datasetId and you only ' +
        'see masked values) → pass `datasetId` INSTEAD of rows; the server resolves the real ' +
        'rows into the canvas (shape them first with v4_select/v4_sort — the column paths ' +
        'become the fieldKeys). NEVER retype masked rows and never wrap the id into `rows`. ' +
        'The data renders directly into the already-visible canvas — do not repeat it as text ' +
        'afterwards. If the tool returns an Error result, do NOT claim success — say briefly ' +
        'what failed.',
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
              'TABULAR containers: one object per row, AT MOST 30 rows per call (more rows → ' +
              'follow-up calls to the same containerId, they append); keys = the promised ' +
              'fieldKeys (optional rowKey/id for stable row identity). MAY be empty ([]) when ' +
              'the fetched data set is genuinely empty — the table then shows its empty state; ' +
              'never invent rows. For a CHART container, each row carries { label: string, ' +
              'value: number } — one row per data point. Use `fields` instead for scalar/KPI ' +
              'containers.',
          },
          fields: {
            type: 'object',
            description:
              'SCALAR/KPI containers ONLY: a flat { fieldKey: value } object of named single ' +
              'values (e.g. a score block: { "seo": 82, "mobile": 90 }). Keys = the promised ' +
              'fieldKeys; values are plain scalars (string/number/boolean). Use INSTEAD of ' +
              '`rows` — never both. The values fill the container’s cards in place.',
          },
          datasetId: {
            type: 'string',
            description:
              'PRIVACY-SHIELD datasets ONLY: the dataset id (ds_…) a tool returned THIS turn. ' +
              'Use INSTEAD of rows/fields — the server resolves the real (unmasked) rows into ' +
              'the canvas; you never see them. Shape the dataset first with v4_select/v4_sort ' +
              'so its column paths match the promised fieldKeys.',
          },
          prose: {
            type: 'string',
            description: 'one short human sentence describing the published data',
          },
          source: {
            type: 'object',
            description:
              'REFRESH RECIPE (pass on the FIRST publish per container): the exact tool + ' +
              'input you just used to fetch this data, plus the fieldKey→attribute map you ' +
              'applied — the canvas then refreshes deterministically without you. TIME RULE: ' +
              'express relative periods with the data source’s RELATIVE operators (FetchXML ' +
              '`next-week`, `this-year`, `last-x-days`, …), NEVER literal dates computed from ' +
              'today — a refresh next month must pull the then-current window. Explicit ranges ' +
              'the user named (e.g. 2025 vs 2026) stay literal. If the query cannot be ' +
              'expressed time-safely, OMIT source.',
            properties: {
              tool: { type: 'string', description: 'tool name to replay (e.g. dynamics_fetchxml)' },
              input: { type: 'object', description: 'the EXACT input object you called it with' },
              itemsPath: {
                type: 'string',
                description: 'dot-path to the record array in the tool output (default: first array)',
              },
              map: {
                type: 'object',
                description: 'fieldKey → attribute name in each result record',
              },
              rowKey: { type: 'string', description: 'attribute carrying a stable row id' },
            },
            required: ['tool', 'map'],
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
        required: ['containerId'],
      },
    },
    // Privacy Shield v4: datasetId publishes resolve the real rows server-side
    // within the current turn. The provider is resolved LAZILY per call (same
    // reasoning as the office plugin): activation order is not guaranteed, and
    // narrow test contexts have no services accessor at all.
    (input) =>
      handleCanvasPublishRows(input, (datasetId) => {
        const turnId = turnContext.current()?.turnId;
        const privacy = (
          ctx.services as PluginContext['services'] | undefined
        )?.get<PrivacyGuardService>(PRIVACY_REDACT_SERVICE_NAME);
        if (turnId === undefined || privacy?.resolveDatasetForRender === undefined) {
          return 'unavailable';
        }
        return privacy.resolveDatasetForRender(turnId, datasetId);
      }),
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
  const disposeLumenTool: (() => void) | undefined = toolsAccessor?.register(
    {
      name: CANVAS_LUMEN_TOOL,
      description:
        'Render an interactive LUMEN (Live Interactivity, omadia-canvas-protocol/1.1) on the canvas: ' +
        'a small live mini-app — a game, an animated/interactive visualization, a tool — that runs ' +
        'Tier-1-fast on the client (up to 60fps, no per-frame server round-trip) as DECLARATIVE DATA ' +
        'run by a shipped deterministic interpreter (no arbitrary code). PREFER authoring a custom ' +
        '`lumen` tailored to the user’s request (see its schema for the grammar + example); the host ' +
        'validates it (whitelist + bounds + determinism) and returns an error for you to fix if it is ' +
        'malformed, so author freely. To visualise the user’s REAL data (e.g. Dynamics records behind ' +
        'the Privacy Shield), pass a `datasetId` a data tool returned THIS turn instead of authoring — ' +
        'the server resolves the real rows and builds an interactive, tappable data Lumen (you never ' +
        'see the unmasked values). Use `variant` only for a quick canned demo. The element renders ' +
        'directly into the canvas — do not also describe it as a static table.',
      input_schema: {
        type: 'object',
        properties: {
          lumen: {
            type: 'object',
            description:
              'A complete Lumen you AUTHOR for the request (preferred). Shape: { "type":"lumen","id":string, ' +
              '"state":{<key>:<leaf>}, "transitions":{<name>:<LX>}, "view":<LX>, "events":[<binding>], "cadence"?:"reactive"|{"tick":<=60} }. ' +
              'LEAF: {"type":"int"|"number",min?,max?,"init":n} | {"type":"bool","init":b} | {"type":"string","maxLength":k,"init":s} | {"type":"enum","values":[..],"init":s} | {"type":"list","of":<leaf>,"maxLen":k,"init":[]} | {"type":"grid","w":W,"h":H,"of":<leaf>} | {"type":"record","fields":{..},"init":{}}. ' +
              'A transition returns a NEW state via {"set":{"<path>":<LX>}}. BINDING: {"on":"tap"|"key"|"tick"|"longPress"|"drag"|"swipe","key"?:s,"rate"?:<=60,"run":"<transitionName>"}. ' +
              'LX NODES: {"lit":v} {"state":"path"} {"event":"field"} {"var":"name"} {"let":{"n":expr},"in":expr} ; ' +
              'arithmetic {"+":[a,b]} "-" "*" "/" "mod" ; compare {">":[a,b]} ">=" "<" "<=" "==" "!=" ; {"and":[..]} {"or":[..]} {"not":x} ; ' +
              '{"if":c,"then":a,"else":b} ; {"match":x,"cases":[{"when":w,"then":t}],"else":e} ; {"record":{k:expr}} {"list":[expr]} {"get":expr,"key":expr} ; ' +
              '{"call":name,"args":[..]} name∈ map,filter,fold,range,len,min,max,clamp,abs,floor,ceil,round,sqrt,sign,pow,concat,slice,contains,indexOf,keys,values,upper,lower,pad,fmt,random,now (map/filter body reads {"var":"it"}/{"var":"idx"}; fold also {"var":"acc"}). NO loops/recursion/eval. ' +
              'VIEW returns a primitive/scene tree. A scene: {"record":{"type":{"lit":"scene"},"width":{"lit":W},"height":{"lit":H},"draw":{"list":[<node>...]}}}, ' +
              'node {"record":{"kind":{"lit":"rect"},"x":..,"y":..,"w":..,"h":..,"fill"?:<token>,"id"?:<lit>}} | "circle"(cx,cy,r) | "line"(x1,y1,x2,y2,stroke) | "text"(x,y,text) | "path"(points) | "group"(children). ' +
              'Colours are THEME TOKENS only: accent, accent.glow, surface, surface-raised, surface-sunken, text, text-muted, success, warning, danger. ' +
              'EXAMPLE (tap counter): {"type":"lumen","id":"counter","state":{"n":{"type":"int","min":0,"init":0}},"transitions":{"inc":{"set":{"n":{"+":[{"state":"n"},{"lit":1}]}}}},"view":{"record":{"type":{"lit":"scene"},"width":{"lit":220},"height":{"lit":80},"draw":{"list":[{"record":{"kind":{"lit":"text"},"x":{"lit":14},"y":{"lit":46},"text":{"call":"concat","args":[{"lit":"taps "},{"call":"fmt","args":[{"state":"n"}]}]},"fill":{"lit":"text"},"id":{"lit":"label"}}}]}}},"events":[{"on":"tap","run":"inc"}]}',
          },
          datasetId: {
            type: 'string',
            description:
              'Build a Lumen from REAL privacy-shielded data: a dataset id (ds_…) a data tool (e.g. dynamics_describe / dynamics_fetchxml) returned THIS turn. The server resolves the real rows and builds an interactive tappable data Lumen — you never see the unmasked values. Use INSTEAD of `lumen` when the user wants their actual data visualised.',
          },
          labelField: {
            type: 'string',
            description: 'with datasetId: which field is the row label (defaults to the first text field).',
          },
          valueField: {
            type: 'string',
            description: 'with datasetId: which field is the numeric value (defaults to the first numeric field).',
          },
          variant: {
            type: 'string',
            enum: ['arcade', 'map', 'defrag'],
            description:
              'Quick canned demo if you are NOT authoring a custom `lumen` or binding a `datasetId`: arcade (game), map (interactive selection + zoom), defrag (tick animation).',
          },
          title: {
            type: 'string',
            description: 'optional heading shown above the Lumen, in the user’s language',
          },
        },
      },
    },
    (input) =>
      handleCanvasPublishLumen(input, (datasetId) => {
        const turnId = turnContext.current()?.turnId;
        const privacy = (
          ctx.services as PluginContext['services'] | undefined
        )?.get<PrivacyGuardService>(PRIVACY_REDACT_SERVICE_NAME);
        if (turnId === undefined || privacy?.resolveDatasetForRender === undefined) {
          return 'unavailable';
        }
        return privacy.resolveDatasetForRender(turnId, datasetId);
      }),
  );
  ctx.log(
    `[omadia-ui-orchestrator] producer tools ${CANVAS_PUBLISH_TOOL}+${CANVAS_CHOICE_TOOL}+${CANVAS_LUMEN_TOOL} ${
      disposeTool ? 'registered' : 'NOT registered (no tools accessor in this context)'
    }`,
  );
  const llm: CompositionLlm = ctx.llm ?? {
    complete: () => Promise.reject(new Error('llm unavailable')),
  };

  const resolveBase = (): ChatAgent | undefined =>
    ctx.services.get<ChatAgentBundle>(CHAT_AGENT_SERVICE)?.agent;

  // LLM-free refresh recipes (omadia-ui#5 phase 2): captured at publish time
  // from the `source` param, replayed via ctx.tools.invoke on canvas_refresh.
  // In-memory per process — a recipe-less canvas falls back to the agent path.
  const refreshRecipes = createRecipeStore();

  // Per-canvasSessionId write mutex (9b-3). A canvas turn mutates ONE shared
  // surface: it counts revisions and patches a tree from a base revision. Two
  // clients on the SAME canvas (multi-window, or a refresh racing a turn from a
  // second socket) would otherwise interleave surface_* events at colliding
  // revisions and force a resync. Each canvas turn/refresh for a session runs
  // behind the previous one; classic turns (no canvasSessionId) never queue.
  // The lock is held for the WHOLE stream and released in finally, so an abort
  // (generator .return()) or a mid-stream throw always frees the next turn.
  const sessionTail = new Map<string, Promise<void>>();
  async function* serializePerSession(
    sessionId: string,
    make: () => AsyncGenerator<ChatStreamEvent>,
  ): AsyncGenerator<ChatStreamEvent> {
    const prev = sessionTail.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    const tail = prev.then(() => mine);
    sessionTail.set(sessionId, tail);
    // a failed/aborted prior turn must never wedge the queue
    await prev.catch(() => {});
    try {
      yield* make();
    } finally {
      release();
      // GC: drop the entry only if no later turn chained after ours
      if (sessionTail.get(sessionId) === tail) sessionTail.delete(sessionId);
    }
  }

  const captureSource = (canvasSessionId: string) => (containerId: string, raw: unknown) => {
    const source = parseRefreshSource(raw);
    if (!source) return undefined;
    refreshRecipes.set(canvasSessionId, containerId, source);
    ctx.log(`[canvas-refresh] recipe captured: ${containerId} via ${source.tool}`);
    // announce refreshability to the client (surface_data_ref_created)
    return mintDataRef(canvasSessionId, containerId);
  };

  async function* canvasTurnStream(
    input: ChatTurnInput,
    observer: Parameters<ChatAgent['chatStream']>[1],
    base: ChatAgent,
    canvasSessionId: string,
  ): AsyncGenerator<ChatStreamEvent> {
    // A structured UI action (choice pick, button click) is the user's ANSWER
    // — handed to the main turn as a [canvas-action] block. Built up-front so
    // both the in-place and skeleton paths below reuse it verbatim.
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

    // ── Deterministic action (LLM-free) ────────────────────────────────────
    // The structured action names a tool whose result is FULLY plugin-determined
    // (a saved-page recall, a status flip, a list view). There is nothing for the
    // model to decide: invoke the tool DIRECTLY with the action payload and feed
    // its sentinel through the SAME synthesis pipeline the agent path uses — no
    // skeleton, no model turn, instant. Deny-by-default: the tool must be in the
    // deterministic-action allow-set AND remain canvas-output-authorised for its
    // sentinel to resolve. Any miss falls through to the in-place/agent paths.
    //
    // Two invocation sources, tried in order: (1) the native tool registry
    // (integrations + the orchestrator's own producer tools), then (2) the
    // `agentToolInvoker` service — the kernel's invoke-one-agent-tool-by-id
    // path, so AGENT-plugin tools (which live behind a `query_<domain>`
    // sub-agent, not in the native registry) are reachable LLM-free too.
    const directActionTool =
      input.action && typeof (input.action as { type?: unknown }).type === 'string'
        ? ((input.action as { type: string }).type)
        : undefined;
    const directInvoke = toolsAccessor?.invoke?.bind(toolsAccessor);
    const agentToolInvoker = ctx.services?.get<{
      invoke(toolId: string, input: unknown): Promise<string | undefined>;
      hasStream?(toolId: string): boolean;
      invokeStream?(toolId: string, input: unknown): AsyncGenerator<string>;
    }>('agentToolInvoker');
    const directInvokeStream = agentToolInvoker?.invokeStream?.bind(agentToolInvoker);
    // Streaming deterministic action: an AGENT-plugin tool may emit several
    // sentinel-bearing results during ONE dispatch (progress snapshot →
    // patches → final snapshot). Decide synchronously up-front; when no stream
    // exists, the legacy one-shot directEvents generator below is reused
    // verbatim.
    const hasDirectStream =
      directActionTool !== undefined &&
      deterministicActionTools.has(directActionTool) &&
      agentToolInvoker?.hasStream?.(directActionTool) === true &&
      directInvokeStream !== undefined;
    if (hasDirectStream && directActionTool && directInvokeStream) {
      const directPayload =
        (input.action as { payload?: unknown }).payload ?? {};
      const baseRevision = (input.canvasState?.basedOnRevision ?? '0') as RevisionId;
      const baseTree = input.canvasState?.currentTree;
      const directEvents = async function* (): AsyncGenerator<ChatStreamEvent> {
        let streamedChunks = 0;
        const t0 = Date.now();
        try {
          for await (const output of directInvokeStream(directActionTool, directPayload)) {
            streamedChunks += 1;
            const id = randomUUID();
            yield { type: 'tool_use', id, name: directActionTool, input: directPayload };
            yield { type: 'tool_result', id, output, durationMs: 0 };
          }
          ctx.log(
            `[deterministic-action] ${directActionTool} STREAMED ${streamedChunks} chunks ` +
              `LLM-free in ${Date.now() - t0}ms (no model turn)`,
          );
        } catch (err) {
          const id = randomUUID();
          const output = JSON.stringify({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
          ctx.log(
            `[deterministic-action] ${directActionTool} failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
          yield { type: 'tool_use', id, name: directActionTool, input: directPayload };
          yield { type: 'tool_result', id, output, durationMs: 0 };
        }
      };
      yield* synthesizeSurfaceEvents(directEvents(), {
        canvasSessionId,
        authorizedToolNames: canvasOutputTools,
        protocolVersion: CANVAS_PROTOCOL_VERSION,
        opsCatalogVersion: OPS_CATALOG_VERSION,
        startSurfaceSeq: 0,
        baseRevision,
        baseTree,
        dataRequirements: baseTree ? deriveDataRequirements(baseTree) : [],
        onPublishedSource: captureSource(canvasSessionId),
        log: (message) => ctx.log(message),
      });
      return;
    }
    if (
      directActionTool &&
      deterministicActionTools.has(directActionTool) &&
      (directInvoke || agentToolInvoker)
    ) {
      const directPayload =
        (input.action as { payload?: unknown }).payload ?? {};
      const baseRevision = (input.canvasState?.basedOnRevision ?? '0') as RevisionId;
      const baseTree = input.canvasState?.currentTree;
      // native registry first, then the agent-plugin invoker — the first source
      // that yields a result wins. Throws only when neither can resolve the id.
      const resolveDirect = async (): Promise<string> => {
        if (directInvoke) {
          try {
            const raw = await directInvoke(directActionTool, directPayload);
            return typeof raw === 'string' ? raw : JSON.stringify(raw);
          } catch (nativeErr) {
            if (!agentToolInvoker) throw nativeErr;
            // native miss (unknown/handler-less) → try the agent-plugin tool
          }
        }
        const viaAgent = await agentToolInvoker?.invoke(directActionTool, directPayload);
        if (viaAgent !== undefined) return viaAgent;
        throw new Error(
          `deterministic-action: '${directActionTool}' not resolvable ` +
            `(native registry miss and no agent-plugin tool of that id)`,
        );
      };
      const directEvents = async function* (): AsyncGenerator<ChatStreamEvent> {
        const id = randomUUID();
        yield { type: 'tool_use', id, name: directActionTool, input: directPayload };
        let output: string;
        try {
          const t0 = Date.now();
          output = await resolveDirect();
          ctx.log(
            `[deterministic-action] ${directActionTool} dispatched LLM-free in ` +
              `${Date.now() - t0}ms (no model turn)`,
          );
        } catch (err) {
          output = JSON.stringify({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
          ctx.log(
            `[deterministic-action] ${directActionTool} failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
        yield { type: 'tool_result', id, output, durationMs: 0 };
      };
      yield* synthesizeSurfaceEvents(directEvents(), {
        canvasSessionId,
        authorizedToolNames: canvasOutputTools,
        protocolVersion: CANVAS_PROTOCOL_VERSION,
        opsCatalogVersion: OPS_CATALOG_VERSION,
        startSurfaceSeq: 0,
        baseRevision,
        baseTree,
        dataRequirements: baseTree ? deriveDataRequirements(baseTree) : [],
        onPublishedSource: captureSource(canvasSessionId),
        log: (message) => ctx.log(message),
      });
      return;
    }

    // ── In-place action (PR-9b-3) ──────────────────────────────────────────
    // The client handed its CURRENT tree + revision: this action should PATCH
    // the live canvas, NOT remount a fresh skeleton. Skip skeleton composition
    // entirely and synthesise on top of `currentTree` — a plugin status-flip
    // emitting `_pendingSurfacePatch` lands as a `surface_patch` (no remount),
    // while an action that genuinely recomposes still replaces the tree via a
    // full snapshot. The data-field contract is derived from the live tree
    // itself, exactly as `canvas_refresh` does, so a republishing action keeps
    // its fieldKeys. surfaceSeq restarts at 0 on the client's revision.
    if (input.canvasState) {
      const requirements = deriveDataRequirements(input.canvasState.currentTree);
      const augmentedInPlace: ChatTurnInput = {
        ...input,
        userMessage:
          input.userMessage +
          actionBlock +
          targetBlock +
          '\n\n[canvas-context]\n' +
          JSON.stringify({
            canvasRevision: input.canvasState.basedOnRevision,
            dataRequirements: requirements,
            instruction:
              'The canvas is ALREADY rendered at the above revision. PERFORM ' +
              'the structured action IN PLACE by INVOKING THE TOOL THAT OWNS ' +
              'IT — for a domain plugin action (e.g. a draft status-update, ' +
              'schedule, or whatever produced this view) call that tool (via ' +
              'its domain query tool if that is how it is reached); the tool ' +
              'emits a precise surface patch that updates only the affected ' +
              'element. Work silently — the canvas is the output channel: do ' +
              'NOT merely describe the change in prose, do NOT ask what the ' +
              'user meant, and do NOT re-run generation. Do NOT recompose the ' +
              'whole view or re-publish unrelated rows unless the action ' +
              'genuinely opens a new view. When you DO publish, key rows ' +
              'EXACTLY by the listed fieldKeys; all published values are ' +
              'PLAIN TEXT, never markdown. After the tool runs, reply with ' +
              'ONE short sentence.',
          }),
      };
      yield* synthesizeSurfaceEvents(base.chatStream(augmentedInPlace, observer), {
        canvasSessionId,
        authorizedToolNames: canvasOutputTools,
        protocolVersion: CANVAS_PROTOCOL_VERSION,
        opsCatalogVersion: OPS_CATALOG_VERSION,
        startSurfaceSeq: 0,
        baseRevision: input.canvasState.basedOnRevision as RevisionId,
        baseTree: input.canvasState.currentTree,
        dataRequirements: requirements,
        onPublishedSource: captureSource(canvasSessionId),
        takeRawSentinel: tapCanvasSentinels((m) => ctx.log(m)),
        log: (message) => ctx.log(message),
      });
      return;
    }

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
            'A dataRequirement that describes a SCALAR/KPI block (named single ' +
            'values, e.g. a score block — its fields are individual metrics, ' +
            'not table columns) is filled by passing `fields` ({ fieldKey: ' +
            'value }) INSTEAD of rows. ' +
            'PRIVACY-SHIELD RULE: when a tool returned a datasetId and you ' +
            'only see masked values, pass that `datasetId` to ' +
            'canvas_publish_rows INSTEAD of rows (shape it first with ' +
            'v4_select/v4_sort so the column paths match the fieldKeys) — ' +
            'the server resolves the real rows; never retype masked data. ' +
            'BATCH RULE: at most 30 rows per call — for larger sets publish ' +
            'batch after batch to the same containerId (calls append), one ' +
            'call at a time, until every row is out; NEVER pack the whole set ' +
            'into one giant call (it gets truncated and dropped). Publish ' +
            'rows: [] when the data set is genuinely empty (never invent ' +
            'rows). On the FIRST publish per container also pass `source` ' +
            '(the exact tool + input you used + fieldKey→attribute map) so ' +
            'the canvas can refresh without you — use the source’s RELATIVE ' +
            'date operators for relative periods (FetchXML next-week, ' +
            'this-year, …), literal values only for ranges the user named ' +
            'explicitly; omit source if not expressible time-safely. All published values are PLAIN TEXT — never ' +
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
      onPublishedSource: captureSource(canvasSessionId),
      takeRawSentinel: tapCanvasSentinels((m) => ctx.log(m)),
      log: (message) => ctx.log(message),
    });
  }

  /** Deterministic refresh (protocol 1.1 `canvas_refresh`, omadia-ui#5, v1):
   *  NO skeleton composition — the client sent its current tree; the data
   *  requirements are derived from that tree's own containers, the main turn
   *  re-fetches silently, and the first publish per container REPLACES its
   *  rows (the consumed `refreshContainers` set). Patches restart surfaceSeq
   *  at 0 on top of the client's revision — the client accepts a seq-0 patch
   *  run whose basedOnRevision matches. The LLM-free dataRef re-resolution
   *  swaps these internals later without touching the wire contract. */
  async function* canvasRefreshStream(
    input: ChatTurnInput,
    observer: Parameters<ChatAgent['chatStream']>[1],
    base: ChatAgent,
    canvasSessionId: string,
    refresh: NonNullable<ChatTurnInput['canvasRefresh']>,
  ): AsyncGenerator<ChatStreamEvent> {
    const requirements = deriveDataRequirements(refresh.currentTree, refresh.scope);
    if (requirements.length === 0) {
      // nothing refreshable in scope — a defined error, not a silent no-op
      yield {
        type: 'surface_error',
        canvasSessionId,
        surfaceSeq: 0,
        revision: refresh.basedOnRevision as RevisionId,
        severity: 'recoverable',
        message: 'refresh_unsupported: no data containers in scope',
      };
      return;
    }
    // LLM-free path (phase 2): when EVERY container in scope has a captured
    // source recipe, re-execute the queries directly and feed the results
    // through the same synthesis pipeline — synthetic publish events, no
    // model anywhere. Any miss/failure → the silent agent turn below.
    const invoke = toolsAccessor?.invoke?.bind(toolsAccessor);
    if (invoke) {
      const jobs: Array<{ containerId: string; rows: Array<Record<string, unknown>> }> = [];
      let deterministic = true;
      for (const req of requirements) {
        const recipe = refreshRecipes.get(canvasSessionId, req.containerId);
        if (!recipe) {
          deterministic = false;
          break;
        }
        try {
          const t0 = Date.now();
          const raw = await invoke(recipe.tool, recipe.input);
          const rows = applyRefreshSource(raw, recipe);
          if (rows === null) {
            ctx.log(
              `[canvas-refresh] recipe for ${req.containerId} unmappable — agent fallback`,
            );
            deterministic = false;
            break;
          }
          ctx.log(
            `[canvas-refresh] deterministic: ${req.containerId} via ${recipe.tool} → ` +
              `${rows.length} rows in ${Date.now() - t0}ms (no LLM)`,
          );
          jobs.push({ containerId: req.containerId, rows });
        } catch (err) {
          ctx.log(
            `[canvas-refresh] recipe ${recipe.tool} failed: ${
              err instanceof Error ? err.message : String(err)
            } — agent fallback`,
          );
          deterministic = false;
          break;
        }
      }
      if (deterministic) {
        const publishEvents = async function* (): AsyncGenerator<ChatStreamEvent> {
          for (const job of jobs) {
            const id = randomUUID();
            yield {
              type: 'tool_use',
              id,
              name: CANVAS_PUBLISH_TOOL,
              input: { containerId: job.containerId },
            };
            const output = await handleCanvasPublishRows({
              containerId: job.containerId,
              rows: job.rows,
            });
            yield { type: 'tool_result', id, output, durationMs: 0 };
          }
        };
        yield* synthesizeSurfaceEvents(publishEvents(), {
          canvasSessionId,
          authorizedToolNames: canvasOutputTools,
          protocolVersion: CANVAS_PROTOCOL_VERSION,
          opsCatalogVersion: OPS_CATALOG_VERSION,
          startSurfaceSeq: 0,
          baseRevision: refresh.basedOnRevision as RevisionId,
          baseTree: refresh.currentTree,
          dataRequirements: requirements,
          refreshContainers: new Set(requirements.map((r) => r.containerId)),
          log: (message) => ctx.log(message),
        });
        return;
      }
    }
    const augmented: ChatTurnInput = {
      ...input,
      userMessage:
        '[canvas-refresh]\n' +
        JSON.stringify({ dataRequirements: requirements }) +
        '\nRe-fetch the CURRENT data for the above containers — same query, ' +
        'newer data, nothing else. Work silently: no narration, no memory ' +
        'commentary. Publish via canvas_publish_rows per containerId with ' +
        'rows keyed EXACTLY by the listed fieldKeys (batches of at most 30 ' +
        'rows, one call at a time; for a privacy-shield datasetId pass ' +
        '`datasetId` instead of rows); the canvas REPLACES the stale rows. On ' +
        'the FIRST publish per container pass `source` (exact tool + input + ' +
        'fieldKey→attribute map, relative date operators for relative ' +
        'periods) so the NEXT refresh runs without you. Do NOT compose a ' +
        'new view, do NOT publish to other containers, do NOT call ' +
        'canvas_publish_choice. Reply with one short sentence.',
    };
    yield* synthesizeSurfaceEvents(base.chatStream(augmented, observer), {
      canvasSessionId,
      authorizedToolNames: canvasOutputTools,
      protocolVersion: CANVAS_PROTOCOL_VERSION,
      opsCatalogVersion: OPS_CATALOG_VERSION,
      startSurfaceSeq: 0,
      baseRevision: refresh.basedOnRevision as RevisionId,
      baseTree: refresh.currentTree,
      dataRequirements: requirements,
      takeRawSentinel: tapCanvasSentinels((m) => ctx.log(m)),
      refreshContainers: new Set(requirements.map((r) => r.containerId)),
      // a fallback refresh that publishes WITH a source upgrades the next
      // refresh of this canvas to the deterministic path
      onPublishedSource: captureSource(canvasSessionId),
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
      const sid = input.canvasSessionId;
      // Serialise all writes to a single canvas behind the per-session mutex.
      if (input.canvasRefresh) {
        const refresh = input.canvasRefresh;
        return serializePerSession(sid, () => canvasRefreshStream(input, observer, base, sid, refresh));
      }
      return serializePerSession(sid, () => canvasTurnStream(input, observer, base, sid));
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
/** Derive the refreshable data requirements from a canvas tree itself — the
 *  tables' own columns ARE the field contract the original skeleton promised
 *  (deterministic, no LLM; omadia-ui#5). `scope` narrows to one containerId. */
/** Scalar/KPI value leaves carry id `${containerId}.${fieldKey}` (the
 *  fields-publish convention). Collect the single-segment fieldKeys of the
 *  scalar leaves (text/heading/status) under `container`. */
function collectFieldLeafKeys(container: Record<string, unknown>, containerId: string): string[] {
  const prefix = `${containerId}.`;
  const keys = new Set<string>();
  const walk = (n: unknown): void => {
    if (Array.isArray(n)) {
      for (const c of n) walk(c);
      return;
    }
    if (typeof n !== 'object' || n === null) return;
    const node = n as Record<string, unknown>;
    const nid = typeof node['id'] === 'string' ? node['id'] : undefined;
    const type = node['type'];
    if (
      nid &&
      nid.startsWith(prefix) &&
      (type === 'text' || type === 'heading' || type === 'status')
    ) {
      const seg = nid.slice(prefix.length);
      if (seg.length > 0 && !seg.includes('.')) keys.add(seg);
    }
    for (const value of Object.values(node)) {
      if (typeof value === 'object' && value !== null) walk(value);
    }
  };
  for (const value of Object.values(container)) {
    if (typeof value === 'object' && value !== null) walk(value);
  }
  return [...keys];
}

export function deriveDataRequirements(tree: unknown, scope?: string): DataRequirement[] {
  const out: DataRequirement[] = [];
  const walk = (n: unknown): void => {
    if (Array.isArray(n)) {
      for (const child of n) walk(child);
      return;
    }
    if (typeof n !== 'object' || n === null) return;
    const node = n as Record<string, unknown>;
    const id = typeof node['id'] === 'string' ? node['id'] : undefined;
    if (id && (!scope || id === scope)) {
      if (node['type'] === 'table' && Array.isArray(node['columns'])) {
        const fields = (node['columns'] as Array<Record<string, unknown>>)
          .filter((c) => typeof c?.['fieldKey'] === 'string')
          .map((c) => ({
            fieldKey: c['fieldKey'] as string,
            label: String(c['label'] ?? c['fieldKey']),
          }));
        if (fields.length > 0) {
          out.push({
            containerId: id,
            description: `refresh: ${String(node['title'] ?? id)}`,
            fields,
          });
        }
      } else if (node['type'] === 'chart') {
        out.push({
          containerId: id,
          description: `refresh chart: ${String(node['title'] ?? id)}`,
          fields: [
            { fieldKey: 'label', label: 'label' },
            { fieldKey: 'value', label: 'value' },
          ],
        });
      } else {
        // Scalar/KPI container: its value leaves carry id `${id}.${fieldKey}`
        // (the fields-publish convention). The leaf ids ARE the field contract.
        const fieldKeys = collectFieldLeafKeys(node, id);
        if (fieldKeys.length > 0) {
          out.push({
            containerId: id,
            description: `refresh fields: ${String(node['title'] ?? id)}`,
            fields: fieldKeys.map((k) => ({ fieldKey: k, label: k })),
          });
        }
      }
    }
    for (const value of Object.values(node)) {
      if (typeof value === 'object' && value !== null) walk(value);
    }
  };
  walk(tree);
  return out;
}

async function* errorStream(): AsyncGenerator<ChatStreamEvent> {
  yield { type: 'error', message: 'orchestrator unavailable' };
}
