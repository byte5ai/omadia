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
 * Two payload shapes are understood:
 *   - `data.rows`   → append rows onto the promised skeleton table. An EMPTY
 *     rows array is legitimate (the data set is genuinely empty) and still
 *     resolves the table's `loading:"skeleton"` state.
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

export function composeStructuredPayloadPatch(opts: {
  baseTree: unknown;
  payload: PendingStructuredPayload;
  dataRequirements: readonly DataRequirement[];
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

  const rows = extractRows(opts.payload);
  if (!rows) return null;

  // Target resolution, in priority order:
  //   1. the containerId the publishing tool named EXPLICITLY (data.containerId)
  //      — authoritative, and the only id that resolves a table nested in a
  //      pane/tab whose id differs from any dataRequirement entry;
  //   2. otherwise the first dataRequirement containerId that resolves to a table.
  // Without (1) a panes/tabs detail view never patches: the agent publishes to
  // "participants", but the requirement list may name it differently.
  let table: { node: TableNode; path: string } | null = null;
  const explicitId =
    typeof (opts.payload.data as { containerId?: unknown } | null)?.containerId === 'string'
      ? ((opts.payload.data as { containerId: string }).containerId)
      : undefined;
  if (explicitId) {
    const hit = findNodeById(opts.baseTree, explicitId, '');
    if (hit && isTableNode(hit.node)) table = { node: hit.node as TableNode, path: hit.path };
  }
  if (!table) {
    for (const req of opts.dataRequirements) {
      const hit = findNodeById(opts.baseTree, req.containerId, '');
      if (hit && isTableNode(hit.node)) {
        table = { node: hit.node as TableNode, path: hit.path };
        break;
      }
    }
  }
  if (!table) return null;

  // Cells are mapped against the SKELETON's own columns — the contract the
  // [canvas-context] handoff asked Tier 3 to fill.
  const fieldKeys = (table.node.columns ?? []).map((c) => c.fieldKey);
  if (fieldKeys.length === 0) return null;

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
              : (v as string | number | boolean);
        return [k, cell];
      }),
    ),
  }));

  const patches: TreePatchOp[] = [];
  if (table.node.loading === 'skeleton') {
    patches.push({ op: 'replace', path: `${table.path}/loading`, value: 'none' });
  }
  for (const row of mapped) {
    patches.push({ op: 'add', path: `${table.path}/rows/-`, value: row });
  }
  // Empty rows + already-resolved loading state → nothing to patch.
  if (patches.length === 0) return null;

  // Apply directly to a clone (the patches above are append/replace on the
  // located node — no generic applier needed server-side).
  const nextTree = structuredClone(opts.baseTree);
  const cloneHit = findNodeById(nextTree, table.node['id'] as string, '');
  if (!cloneHit || !isTableNode(cloneHit.node)) return null;
  if (cloneHit.node.loading === 'skeleton') cloneHit.node['loading'] = 'none';
  cloneHit.node.rows.push(...mapped);

  if (!validateTree(nextTree).ok) return null;
  return { patches, nextTree };
}
