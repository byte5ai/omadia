import { randomUUID } from 'node:crypto';

import { type CanvasResolvedDataset } from './datasetColumnLabels.js';
import { buildDatasetLumen } from './datasetLumen.js';
import { parseVariant } from './recipeVariant.js';
import { resolveReferenceLumen } from './referenceLumens.js';
import { validateLumenNode } from './treeValidator.js';

/**
 * Native handlers of the canvas producer tools (`canvas_publish_rows`,
 * `canvas_publish_choice`, `canvas_publish_lumen`) — pure input → sentinel
 * string; registration lives in `canvasPublishTools.ts`. Re-exported from
 * `plugin.ts`.
 */

/** Tier-3 producer tool — the first consumer of the canvas-output path. The
 *  [canvas-context] handoff instructs the main turn to publish fetched rows
 *  through this tool; its result string carries the
 *  `_pendingStructuredPayload` sentinel that surface synthesis maps onto the
 *  skeleton as a deterministic `surface_patch`. Always in the allow-set. */
export const CANVAS_PUBLISH_TOOL = 'canvas_publish_rows';

/** Privacy Shield v4 table renders publish a full `_pendingCanvasTree`
 *  snapshot through the canvas-sentinel tap — never in the streamed
 *  `tool_result`, which is the model's shape-only ack (#1402). The tool must
 *  still be authorised so synthesis takes its tapped snapshot. */
export const V4_RENDER_TOOL = 'v4_render_answer';

/** Resolves a privacy-shield datasetId to its real rows within the current
 *  turn. Returns `'unavailable'` when no privacy provider with dataset
 *  support is active (or no turn context exists), `undefined` for an
 *  unknown/expired id. Mirrors the office plugin's adapter pattern. */
export type CanvasDatasetResolver = (
  datasetId: string,
) => CanvasResolvedDataset | 'unavailable' | undefined;

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
  /** server-internal (fast path): the plan's columns REPLACE the table's —
   *  published as `datasetColumns` with labels (never an agent argument) */
  internal?: { columns?: ReadonlyArray<{ fieldKey: string; label: string }> },
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
      'For shielded data pass ONLY the datasetId — the server maps its columns onto the canvas.'
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
  /** #326 — the resolved dataset's authoritative column schema, forwarded to
   *  the composer so cells resolve by PATH rather than by the skeleton's own
   *  field keys. Undefined for a plain `rows` publish, where the agent's keys
   *  already are the row keys and nothing needs remapping. */
  let datasetColumns:
    | Array<{ path: string; type: string; classification?: string; label?: string; defaultLabel?: string }>
    | undefined =
    internal?.columns && internal.columns.length > 0
      ? internal.columns.map((c) => ({ path: c.fieldKey, type: 'string', label: c.label }))
      : undefined;
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
    // The dataset's own column schema travels with the rows. Without it the
    // composer maps cells by the SKELETON's field keys, which are the agent's
    // naming — `invoice_number` where the source path is Odoo's `name` — and
    // every mismatched column renders blank. The paths here are authoritative
    // because they are the keys the rows are actually built on.
    datasetColumns = resolved.columns.map((c) => ({
      path: c.path,
      type: c.type,
      ...(c.classification ? { classification: c.classification } : {}),
      // the header when the agent names none (datasetColumnLabels.ts)
      ...(c.defaultLabel ? { defaultLabel: c.defaultLabel } : {}),
    }));
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
    .map((a, i) => {
      // a declarative recipe variant rides along server-side only (the
      // registry validates it again on the click); an invalid one is dropped
      // and the action stays a plain prompt action
      const variant = parseVariant(a['variant']);
      return {
        id: typeof a['id'] === 'string' && a['id'].length > 0 ? a['id'] : `act-${i}`,
        label: (a['label'] as string).trim(),
        ...(typeof a['prompt'] === 'string' && a['prompt'].trim().length > 0
          ? { prompt: a['prompt'].trim() }
          : {}),
        ...(variant ? { variant } : {}),
      };
    });
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
        ...(datasetColumns ? { datasetColumns } : {}),
        // the opaque handle only (it is in the call input already) — the
        // synthesis layer derives a refresh recipe from its provenance
        ...(datasetId !== undefined ? { datasetId } : {}),
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
  const dataRows = Array.isArray(args['data'])
    ? (args['data'] as unknown[]).filter(
        (r): r is Record<string, unknown> => typeof r === 'object' && r !== null && !Array.isArray(r),
      )
    : undefined;
  const authored = args['lumen'];

  if (datasetId === undefined && dataRows !== undefined && dataRows.length > 0) {
    // Rows the agent already holds (e.g. an unshielded fetch) → build the data
    // Lumen deterministically here, no LX-authoring required of the model.
    const labelField = typeof args['labelField'] === 'string' ? args['labelField'] : undefined;
    const valueField = typeof args['valueField'] === 'string' ? args['valueField'] : undefined;
    lumen = buildDatasetLumen(dataRows, { labelField, valueField });
    if (title === '') title = 'Live Interactivity — Data Lumen';
  } else if (datasetId !== undefined) {
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
