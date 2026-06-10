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
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const objects = rows.filter(
    (r): r is Record<string, unknown> => typeof r === 'object' && r !== null && !Array.isArray(r),
  );
  return objects.length === rows.length ? objects : null;
}

export function composeStructuredPayloadPatch(opts: {
  baseTree: unknown;
  payload: PendingStructuredPayload;
  dataRequirements: readonly DataRequirement[];
}): ComposedPatch | null {
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
