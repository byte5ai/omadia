import type { PendingStructuredPayload } from '@omadia/orchestrator';

import type { DataRequirement } from './composition.js';
import { validateTree } from './treeValidator.js';

/**
 * Deterministic `_pendingStructuredPayload` → `surface_patch` composition
 * (PR-9b-2, no LLM call on this path): map the payload's rows onto the
 * skeleton table the data requirement points at, generating the RFC-6902
 * subset ops pinned in omadia-ui `docs/protocol/1.0.md` §5.1.
 *
 * Returns null when the payload cannot be mapped safely (no rows, no matching
 * table container, post-patch tree fails the whitelist) — the synthesiser then
 * skips the patch and the data still reaches the user as prose. Skipping
 * (instead of an LLM recomposition snapshot) is the deliberate v1 slice:
 * no mid-stream model call, no risk of a malformed patch.
 *
 * Three payload shapes are understood:
 *   - `data.rows`   → append rows onto the promised skeleton table (or points
 *     onto a chart). An EMPTY rows array is legitimate (the data set is
 *     genuinely empty) and still resolves the `loading:"skeleton"` state.
 *   - `data.fields` → the scalar analogue of rows: a `{ fieldKey: value }`
 *     object fills a KPI/score container whose value leaf nodes carry the id
 *     `${containerId}.${fieldKey}` (text/heading `content`, status `text`).
 *     Generic — any capability whose output_schema has a flat scalar object
 *     (e.g. SEO `score{}`) renders without a bespoke producer.
 *   - `data.choice` → append a `choice` element (disambiguation: "which of
 *     these did you mean?") into the target container, so the user picks via
 *     the canvas instead of a prose round-trip.
 */

export interface TreePatchOp {
  op: 'add' | 'replace';
  path: string;
  value?: unknown;
}

export interface ComposedPatch {
  patches: TreePatchOp[];
  nextTree: unknown;
}

interface TableNode {
  type: 'table';
  loading?: string;
  columns?: Array<{ fieldKey: string; label: string }>;
  rows: Array<{ rowKey: string; cells: Record<string, unknown> }>;
  [key: string]: unknown;
}

function escapePointerSegment(seg: string): string {
  return seg.replace(/~/g, '~0').replace(/\//g, '~1');
}

/** Depth-first search for a node with the given `id`, tracking its JSON-Pointer. */
function findNodeById(
  node: unknown,
  id: string,
  path: string,
): { node: Record<string, unknown>; path: string } | null {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i += 1) {
      const hit = findNodeById(node[i], id, `${path}/${i}`);
      if (hit) return hit;
    }
    return null;
  }
  if (typeof node === 'object' && node !== null) {
    const obj = node as Record<string, unknown>;
    if (obj['id'] === id) return { node: obj, path };
    for (const [key, value] of Object.entries(obj)) {
      if (typeof value === 'object' && value !== null) {
        const hit = findNodeById(value, id, `${path}/${escapePointerSegment(key)}`);
        if (hit) return hit;
      }
    }
  }
  return null;
}

function isTableNode(node: Record<string, unknown>): node is TableNode {
  return node['type'] === 'table' && Array.isArray(node['rows']);
}

interface ChartNode {
  type: 'chart';
  loading?: string;
  points: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

function isChartNode(node: Record<string, unknown>): node is ChartNode {
  return node['type'] === 'chart' && Array.isArray(node['points']);
}

/** Map a published row onto a chart point: the idiom keys are `label` +
 *  `value`; fall back to the first string / first finite number in the row. */
function toChartPoint(
  row: Record<string, unknown>,
  i: number,
  dataRefId: string,
): { pointKey: string; label: string; value: number } | null {
  const asNumber = (v: unknown): number =>
    typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  let label = typeof row['label'] === 'string' ? (row['label'] as string) : undefined;
  let value = Number.isFinite(asNumber(row['value'])) ? asNumber(row['value']) : undefined;
  for (const [k, v] of Object.entries(row)) {
    if (k === 'rowKey' || k === 'id' || k === 'pointKey') continue;
    if (label === undefined && typeof v === 'string' && !Number.isFinite(Number(v))) {
      label = stripInlineMarkdown(v);
    } else if (value === undefined && Number.isFinite(asNumber(v))) {
      value = asNumber(v);
    }
  }
  if (value === undefined) return null;
  return {
    pointKey: String(row['pointKey'] ?? row['rowKey'] ?? row['id'] ?? `${dataRefId}-${i}`),
    label: label ?? String(i + 1),
    value,
  };
}

/** Rows published against a CHART container become points (loading resolved).
 *  The publishing turn may OVERRIDE the skeleton's chartType — the chart kind
 *  is a Tier-2 decision, and the main turn has seen the actual data shape. */
function composeChartRowsPatch(
  chart: { node: ChartNode; path: string },
  rows: Array<Record<string, unknown>>,
  opts: { baseTree: unknown; payload: PendingStructuredPayload; refreshContainers?: Set<string> },
): ComposedPatch | null {
  const points = rows
    .map((row, i) => toChartPoint(row, i, opts.payload.dataRefId))
    .filter((p): p is NonNullable<typeof p> => p !== null);
  // some rows but no mappable numbers → unmappable; data stays prose
  if (rows.length > 0 && points.length === 0) return null;

  const requestedType = (opts.payload.data as { chartType?: unknown }).chartType;
  const chartType =
    requestedType === 'bar' || requestedType === 'line' || requestedType === 'pie'
      ? requestedType
      : undefined;

  const patches: TreePatchOp[] = [];
  if (chart.node.loading === 'skeleton') {
    patches.push({ op: 'replace', path: `${chart.path}/loading`, value: 'none' });
  }
  if (chartType && chart.node['chartType'] !== chartType) {
    patches.push({ op: 'replace', path: `${chart.path}/chartType`, value: chartType });
  }
  const replacePoints = opts.refreshContainers?.delete(String(chart.node['id'])) === true;
  if (replacePoints) {
    patches.push({ op: 'replace', path: `${chart.path}/points`, value: points });
  } else {
    for (const p of points) {
      patches.push({ op: 'add', path: `${chart.path}/points/-`, value: p });
    }
  }
  if (patches.length === 0) return null;

  const nextTree = structuredClone(opts.baseTree);
  const cloneHit = findNodeById(nextTree, chart.node['id'] as string, '');
  if (!cloneHit || !isChartNode(cloneHit.node)) return null;
  if (cloneHit.node.loading === 'skeleton') cloneHit.node['loading'] = 'none';
  if (chartType) cloneHit.node['chartType'] = chartType;
  if (replacePoints) cloneHit.node.points.splice(0, cloneHit.node.points.length, ...points);
  else cloneHit.node.points.push(...points);

  if (!validateTree(nextTree).ok) return null;
  return { patches, nextTree };
}

function extractRows(payload: PendingStructuredPayload): Array<Record<string, unknown>> | null {
  const data = payload.data;
  if (typeof data !== 'object' || data === null) return null;
  const rows = (data as { rows?: unknown }).rows;
  if (!Array.isArray(rows)) return null;
  const objects = rows.filter(
    (r): r is Record<string, unknown> => typeof r === 'object' && r !== null && !Array.isArray(r),
  );
  return objects.length === rows.length ? objects : null;
}

/** Canvas content is plain text (protocol §2) — models still emit markdown
 *  emphasis into values. Strip the inline markers, keep the text. */
function stripInlineMarkdown(s: string): string {
  return s
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1');
}

/** container-like primitives a disambiguation `choice` may be appended into. */
function canHostChildren(node: Record<string, unknown>): boolean {
  const t = node['type'];
  return t === 'container' || t === 'pane' || t === 'form';
}

function composeChoicePatch(opts: {
  baseTree: unknown;
  payload: PendingStructuredPayload;
}): ComposedPatch | null {
  const data = opts.payload.data as Record<string, unknown>;
  const choice = data['choice'] as Record<string, unknown>;
  const options = (Array.isArray(choice['options']) ? choice['options'] : []).filter(
    (o): o is { value: string; label: string } =>
      typeof o === 'object' &&
      o !== null &&
      typeof (o as { value?: unknown }).value === 'string' &&
      typeof (o as { label?: unknown }).label === 'string',
  );
  if (options.length < 2) return null;

  // Target: the explicitly named container if it can host children, else the
  // root container — a disambiguation question is page-level by default.
  const explicitId = typeof data['containerId'] === 'string' ? data['containerId'] : undefined;
  let target: { node: Record<string, unknown>; path: string } | null = null;
  if (explicitId) {
    const hit = findNodeById(opts.baseTree, explicitId, '');
    if (hit && canHostChildren(hit.node)) target = hit;
  }
  if (!target) {
    const root = opts.baseTree;
    if (typeof root === 'object' && root !== null && canHostChildren(root as Record<string, unknown>)) {
      target = { node: root as Record<string, unknown>, path: '' };
    }
  }
  if (!target) return null;

  const node = {
    type: 'choice',
    id: `choice_${opts.payload.dataRefId.slice(0, 8)}`,
    ...(typeof choice['question'] === 'string' && choice['question'].length > 0
      ? { label: choice['question'] }
      : {}),
    variant: choice['variant'] === 'dropdown' ? 'dropdown' : 'radio',
    options: options.map((o) => ({ value: o.value, label: o.label })),
  };
  const hasChildren = Array.isArray(target.node['children']);
  const patches: TreePatchOp[] = [
    hasChildren
      ? { op: 'add', path: `${target.path}/children/-`, value: node }
      : { op: 'add', path: `${target.path}/children`, value: [node] },
  ];

  const nextTree = structuredClone(opts.baseTree);
  const cloneHit =
    target.path === ''
      ? { node: nextTree as Record<string, unknown>, path: '' }
      : findNodeById(nextTree, target.node['id'] as string, '');
  if (!cloneHit) return null;
  const children = Array.isArray(cloneHit.node['children'])
    ? (cloneHit.node['children'] as unknown[])
    : [];
  children.push(node);
  cloneHit.node['children'] = children;

  if (!validateTree(nextTree).ok) return null;
  return { patches, nextTree };
}

function isScalar(v: unknown): v is string | number | boolean {
  return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
}

/** The value-bearing prop of a fillable scalar LEAF primitive: text/heading
 *  carry `content`, status carries `text`. null = not a scalar value node. */
function scalarValueProp(node: Record<string, unknown>): 'content' | 'text' | null {
  const t = node['type'];
  if (t === 'text' || t === 'heading') return 'content';
  if (t === 'status') return 'text';
  return null;
}

function extractFields(
  payload: PendingStructuredPayload,
): Record<string, string | number | boolean> | null {
  const data = payload.data;
  if (typeof data !== 'object' || data === null) return null;
  const fields = (data as { fields?: unknown }).fields;
  if (typeof fields !== 'object' || fields === null || Array.isArray(fields)) return null;
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (isScalar(v)) out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : null;
}

const fieldText = (v: string | number | boolean): string =>
  typeof v === 'string' ? stripInlineMarkdown(v) : String(v);

/**
 * Fill a KPI/score container from a `data.fields` payload — the scalar analogue
 * of rows→table. Each value lives in a leaf node whose id is exactly
 * `${containerId}.${fieldKey}`; we `replace` that leaf's value prop and resolve
 * the container's (and leaf's) `loading:"skeleton"` to "none". Generic: the
 * convention is schema-driven, not capability-specific.
 *
 * Returns null when no value node matches (unmappable → data stays prose) or the
 * post-patch tree fails the whitelist.
 */
function composeFieldsPatch(opts: {
  baseTree: unknown;
  payload: PendingStructuredPayload;
  refreshContainers?: Set<string>;
  log?: (message: string) => void;
}): ComposedPatch | null {
  const fields = extractFields(opts.payload);
  if (!fields) return null;
  const containerId =
    typeof (opts.payload.data as { containerId?: unknown }).containerId === 'string'
      ? (opts.payload.data as { containerId: string }).containerId
      : undefined;
  if (!containerId) {
    opts.log?.('[patch-composition] skip fields: no containerId');
    return null;
  }
  const container = findNodeById(opts.baseTree, containerId, '');
  if (!container) {
    opts.log?.(`[patch-composition] skip fields: container ${containerId} not found`);
    return null;
  }

  const patches: TreePatchOp[] = [];
  if (container.node['loading'] === 'skeleton') {
    patches.push({ op: 'replace', path: `${container.path}/loading`, value: 'none' });
  }
  let mappedAny = false;
  for (const [fieldKey, value] of Object.entries(fields)) {
    const hit = findNodeById(opts.baseTree, `${containerId}.${fieldKey}`, '');
    if (!hit) continue;
    const prop = scalarValueProp(hit.node);
    if (!prop) continue;
    patches.push({ op: 'replace', path: `${hit.path}/${prop}`, value: fieldText(value) });
    if (hit.node['loading'] === 'skeleton') {
      patches.push({ op: 'replace', path: `${hit.path}/loading`, value: 'none' });
    }
    mappedAny = true;
  }
  if (!mappedAny) {
    opts.log?.(
      `[patch-composition] skip fields: no value nodes (${containerId}.<fieldKey>) matched ` +
        `(fields=${Object.keys(fields).join(',')})`,
    );
    return null;
  }
  // scalar set is idempotent, but keep the refresh bookkeeping consistent
  opts.refreshContainers?.delete(containerId);
  if (patches.length === 0) return null;

  const nextTree = structuredClone(opts.baseTree);
  const cNext = findNodeById(nextTree, containerId, '');
  if (cNext && cNext.node['loading'] === 'skeleton') cNext.node['loading'] = 'none';
  for (const [fieldKey, value] of Object.entries(fields)) {
    const hit = findNodeById(nextTree, `${containerId}.${fieldKey}`, '');
    if (!hit) continue;
    const prop = scalarValueProp(hit.node);
    if (!prop) continue;
    hit.node[prop] = fieldText(value);
    if (hit.node['loading'] === 'skeleton') hit.node['loading'] = 'none';
  }

  const valid = validateTree(nextTree);
  if (!valid.ok) {
    opts.log?.(`[patch-composition] skip fields: post-patch tree schema-invalid: ${valid.errors}`);
    return null;
  }
  return { patches, nextTree };
}

export function composeStructuredPayloadPatch(opts: {
  baseTree: unknown;
  payload: PendingStructuredPayload;
  dataRequirements: readonly DataRequirement[];
  /** observability — every skip states its reason (a dropped patch reads as
   *  "empty canvas" to the user; silence here cost us a debugging session). */
  log?: (message: string) => void;
  /** deterministic refresh (omadia-ui#5): containers whose FIRST publish of
   *  this stream REPLACES the stale rows/points instead of appending. The
   *  set is consumed — a container is removed on its first hit, so follow-up
   *  batches append onto the freshly replaced data. */
  refreshContainers?: Set<string>;
}): ComposedPatch | null {
  const data = opts.payload.data;
  if (
    typeof data === 'object' &&
    data !== null &&
    typeof (data as { choice?: unknown }).choice === 'object' &&
    (data as { choice?: unknown }).choice !== null
  ) {
    return composeChoicePatch(opts);
  }

  // Scalar/KPI container fill — the `data.fields` analogue of rows→table.
  if (
    typeof data === 'object' &&
    data !== null &&
    typeof (data as { fields?: unknown }).fields === 'object' &&
    (data as { fields?: unknown }).fields !== null &&
    !Array.isArray((data as { fields?: unknown }).fields)
  ) {
    return composeFieldsPatch({
      baseTree: opts.baseTree,
      payload: opts.payload,
      ...(opts.refreshContainers ? { refreshContainers: opts.refreshContainers } : {}),
      ...(opts.log ? { log: opts.log } : {}),
    });
  }

  const rows = extractRows(opts.payload);
  if (!rows) {
    opts.log?.('[patch-composition] skip: data.rows missing or not an array of objects');
    return null;
  }

  // Target resolution, in priority order:
  //   1. the containerId the publishing tool named EXPLICITLY (data.containerId)
  //      — authoritative, and the only id that resolves a table nested in a
  //      pane/tab whose id differs from any dataRequirement entry;
  //   2. otherwise the first dataRequirement containerId that resolves to a table.
  // Without (1) a panes/tabs detail view never patches: the agent publishes to
  // "participants", but the requirement list may name it differently.
  const isDataNode = (n: Record<string, unknown>): boolean => isTableNode(n) || isChartNode(n);
  const explicitId =
    typeof (opts.payload.data as { containerId?: unknown } | null)?.containerId === 'string'
      ? ((opts.payload.data as { containerId: string }).containerId)
      : undefined;
  let hit: { node: Record<string, unknown>; path: string } | null = null;
  if (explicitId) {
    const h = findNodeById(opts.baseTree, explicitId, '');
    if (h && isDataNode(h.node)) hit = h;
  }
  if (!hit) {
    for (const req of opts.dataRequirements) {
      const h = findNodeById(opts.baseTree, req.containerId, '');
      if (h && isDataNode(h.node)) {
        hit = h;
        break;
      }
    }
  }
  if (!hit) {
    opts.log?.(
      `[patch-composition] skip: no table/chart resolves (explicit=${String(explicitId)}, ` +
        `requirements=${opts.dataRequirements.map((r) => r.containerId).join(',')})`,
    );
    return null;
  }
  // rows published against a chart container become points
  if (isChartNode(hit.node)) {
    return composeChartRowsPatch({ node: hit.node, path: hit.path }, rows, opts);
  }
  if (!isTableNode(hit.node)) return null;
  const table: { node: TableNode; path: string } = { node: hit.node, path: hit.path };

  // Cells are mapped against the SKELETON's own columns — the contract the
  // [canvas-context] handoff asked Tier 3 to fill.
  const fieldKeys = (table.node.columns ?? []).map((c) => c.fieldKey);
  if (fieldKeys.length === 0) {
    opts.log?.(`[patch-composition] skip: table ${String(table.node['id'])} has no columns`);
    return null;
  }

  const mapped = rows.map((row, i) => ({
    rowKey: String(row['rowKey'] ?? row['id'] ?? `${opts.payload.dataRefId}-${i}`),
    cells: Object.fromEntries(
      fieldKeys.map((k) => {
        const v = row[k];
        const cell =
          v === undefined || v === null
            ? ''
            : typeof v === 'object'
              ? JSON.stringify(v)
              : typeof v === 'string'
                ? stripInlineMarkdown(v)
                : (v as number | boolean);
        return [k, cell];
      }),
    ),
  }));

  const patches: TreePatchOp[] = [];
  if (table.node.loading === 'skeleton') {
    patches.push({ op: 'replace', path: `${table.path}/loading`, value: 'none' });
  }
  const replaceRows = opts.refreshContainers?.delete(String(table.node['id'])) === true;
  if (replaceRows) {
    patches.push({ op: 'replace', path: `${table.path}/rows`, value: mapped });
  } else {
    for (const row of mapped) {
      patches.push({ op: 'add', path: `${table.path}/rows/-`, value: row });
    }
  }

  // Agent-authored row context-menu entries → suggestedActions on the table
  // (protocol commonTraits). The agent knows the current view; the client
  // falls back to its generic affordance only when none arrive.
  const rawActions = (opts.payload.data as { actions?: unknown }).actions;
  const tableId = typeof table.node['id'] === 'string' ? (table.node['id'] as string) : undefined;
  const suggestedActions =
    Array.isArray(rawActions) && tableId
      ? rawActions
          .filter(
            (a): a is { id: string; label: string; prompt?: string } =>
              typeof a === 'object' &&
              a !== null &&
              typeof (a as { id?: unknown }).id === 'string' &&
              typeof (a as { label?: unknown }).label === 'string',
          )
          .map((a) => ({
            id: a.id,
            label: stripInlineMarkdown(a.label),
            effect: 'internal',
            target: { kind: 'container', containerId: tableId },
            ...(typeof a.prompt === 'string' ? { prompt: stripInlineMarkdown(a.prompt) } : {}),
          }))
      : [];
  if (suggestedActions.length > 0) {
    patches.push({
      op: Array.isArray(table.node['suggestedActions']) ? 'replace' : 'add',
      path: `${table.path}/suggestedActions`,
      value: suggestedActions,
    });
  }

  // Empty rows + already-resolved loading state → nothing to patch.
  if (patches.length === 0) return null;

  // Apply directly to a clone (the patches above are append/replace on the
  // located node — no generic applier needed server-side).
  const nextTree = structuredClone(opts.baseTree);
  const cloneHit = findNodeById(nextTree, table.node['id'] as string, '');
  if (!cloneHit || !isTableNode(cloneHit.node)) return null;
  if (cloneHit.node.loading === 'skeleton') cloneHit.node['loading'] = 'none';
  if (replaceRows) cloneHit.node.rows.splice(0, cloneHit.node.rows.length, ...mapped);
  else cloneHit.node.rows.push(...mapped);
  if (suggestedActions.length > 0) cloneHit.node['suggestedActions'] = suggestedActions;

  const valid = validateTree(nextTree);
  if (!valid.ok) {
    opts.log?.(`[patch-composition] skip: post-patch tree schema-invalid: ${valid.errors}`);
    return null;
  }
  return { patches, nextTree };
}
