/**
 * surface_patch op grammar — RFC-6902 subset {add, replace, remove}.
 * The schema leaves `patches` items open ("op/path/value" hint); this module is
 * the spike-pinned concrete grammar, recorded as protocol feedback (1.0.md §5.1).
 * Positional array indices are safe here because basedOnRevision equality pins
 * the tree shape the path was authored against.
 */

export interface TreePatchOp {
  op: 'add' | 'replace' | 'remove';
  path: string;
  value?: unknown;
}

function isTreePatchOp(p: unknown): p is TreePatchOp {
  if (typeof p !== 'object' || p === null) return false;
  const { op, path } = p as { op?: unknown; path?: unknown };
  return (op === 'add' || op === 'replace' || op === 'remove') && typeof path === 'string' && path.startsWith('/');
}

function parsePointer(path: string): string[] {
  return path
    .split('/')
    .slice(1)
    .map((seg) => seg.replace(/~1/g, '/').replace(/~0/g, '~'));
}

function navigate(root: unknown, segments: string[]): unknown {
  let node: unknown = root;
  for (const seg of segments) {
    if (Array.isArray(node)) {
      const idx = Number(seg);
      if (!Number.isInteger(idx) || idx < 0 || idx >= node.length) {
        throw new Error(`patch path segment out of range: ${seg}`);
      }
      node = node[idx];
    } else if (typeof node === 'object' && node !== null) {
      if (!(seg in (node as Record<string, unknown>))) {
        throw new Error(`patch path segment not found: ${seg}`);
      }
      node = (node as Record<string, unknown>)[seg];
    } else {
      throw new Error(`patch path traverses a non-container at: ${seg}`);
    }
  }
  return node;
}

/** Apply patches immutably; throws on any malformed/unresolvable op. */
export function applyTreePatches(tree: unknown, patches: unknown[]): unknown {
  const root = structuredClone(tree);
  for (const p of patches) {
    if (!isTreePatchOp(p)) throw new Error('malformed patch op');
    const segments = parsePointer(p.path);
    if (segments.length === 0) throw new Error('whole-document patches are not allowed');
    const last = segments[segments.length - 1] as string;
    const parent = navigate(root, segments.slice(0, -1));

    if (Array.isArray(parent)) {
      if (p.op === 'add' && last === '-') {
        parent.push(p.value);
        continue;
      }
      const idx = Number(last);
      if (!Number.isInteger(idx) || idx < 0) throw new Error(`bad array index: ${last}`);
      if (p.op === 'add') {
        if (idx > parent.length) throw new Error(`add index out of range: ${idx}`);
        parent.splice(idx, 0, p.value);
      } else if (p.op === 'replace') {
        if (idx >= parent.length) throw new Error(`replace index out of range: ${idx}`);
        parent[idx] = p.value;
      } else {
        if (idx >= parent.length) throw new Error(`remove index out of range: ${idx}`);
        parent.splice(idx, 1);
      }
    } else if (typeof parent === 'object' && parent !== null) {
      const obj = parent as Record<string, unknown>;
      if (p.op === 'add') {
        obj[last] = p.value;
      } else if (p.op === 'replace') {
        if (!(last in obj)) throw new Error(`replace target missing: ${last}`);
        obj[last] = p.value;
      } else {
        if (!(last in obj)) throw new Error(`remove target missing: ${last}`);
        delete obj[last];
      }
    } else {
      throw new Error('patch parent is not a container');
    }
  }
  return root;
}
