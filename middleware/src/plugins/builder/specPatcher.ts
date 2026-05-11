import { z } from 'zod';

import { parseAgentSpec, type AgentSpec } from './agentSpec.js';

/**
 * RFC-6902-subset patch operation. The Builder needs `add`/`replace`/`remove`
 * for incremental spec mutation; `move`/`copy`/`test` are intentionally omitted
 * to keep the patch surface small and the rollback semantics trivial.
 */
export const JsonPatchSchema = z.discriminatedUnion('op', [
  z
    .object({
      op: z.literal('add'),
      path: z.string(),
      value: z.unknown(),
    })
    .strict(),
  z
    .object({
      op: z.literal('replace'),
      path: z.string(),
      value: z.unknown(),
    })
    .strict(),
  z
    .object({
      op: z.literal('remove'),
      path: z.string(),
    })
    .strict(),
]);

export type JsonPatch = z.infer<typeof JsonPatchSchema>;

export class IllegalSpecState extends Error {
  override readonly name = 'IllegalSpecState';
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
  }
}

/**
 * Apply RFC-6902-subset patches against an arbitrary JSON-shaped value and
 * return the result. No schema validation — the caller decides whether the
 * post-patch shape needs to satisfy a contract. All-or-nothing on the patch
 * level: patches are applied on a deep clone; the original is never mutated;
 * if any patch fails to resolve (bad pointer, out-of-bounds, type mismatch),
 * the call throws `IllegalSpecState` and the original is untouched.
 *
 * Used by the Builder when patching a mid-construction `AgentSpecSkeleton`
 * — the spec may not yet be Zod-valid (empty `id`/`name` etc.) and patching
 * those fields one-by-one is exactly what the LLM is doing.
 */
export function applyJsonPatchesRaw(
  target: unknown,
  patches: ReadonlyArray<JsonPatch>,
): unknown {
  const draft = clone(target);

  let mutated: unknown = draft;
  for (let i = 0; i < patches.length; i += 1) {
    const patch = patches[i];
    if (!patch) continue;
    try {
      mutated = applyOne(mutated, patch);
    } catch (err) {
      throw new IllegalSpecState(
        `Patch #${i} (${patch.op} ${patch.path}) failed: ${(err as Error).message}`,
        err,
      );
    }
  }

  return mutated;
}

/**
 * Apply RFC-6902-subset patches against a (Zod-valid) `AgentSpec` and re-
 * validate the result. Used by the inline-editor PATCH endpoints where the
 * user is editing a spec that's already passed lint.
 */
export function applySpecPatches(
  spec: AgentSpec,
  patches: ReadonlyArray<JsonPatch>,
): { spec: AgentSpec; applied: JsonPatch[] } {
  const mutated = applyJsonPatchesRaw(spec, patches);

  let validated: AgentSpec;
  try {
    validated = parseAgentSpec(mutated);
  } catch (err) {
    throw new IllegalSpecState(
      `Patched spec failed AgentSpec validation: ${(err as Error).message}`,
      err,
    );
  }

  return { spec: validated, applied: [...patches] };
}

// ---------------------------------------------------------------------------
// JSON-Pointer (RFC 6901) handling
// ---------------------------------------------------------------------------

function decodeSegment(seg: string): string {
  // RFC 6901: `~1` → `/`, `~0` → `~` (order matters)
  return seg.replace(/~1/g, '/').replace(/~0/g, '~');
}

function parsePointer(path: string): string[] {
  if (path === '') return [];
  if (!path.startsWith('/')) {
    throw new Error(`JSON pointer must start with '/' (got '${path}')`);
  }
  return path.slice(1).split('/').map(decodeSegment);
}

// ---------------------------------------------------------------------------
// Patch primitives
// ---------------------------------------------------------------------------

function applyOne(target: unknown, patch: JsonPatch): unknown {
  const segments = parsePointer(patch.path);

  if (segments.length === 0) {
    if (patch.op === 'remove') {
      throw new Error('cannot remove root document');
    }
    if (patch.op === 'add' || patch.op === 'replace') {
      return patch.value;
    }
  }

  const parent = traverse(target, segments.slice(0, -1));
  const key = segments[segments.length - 1] ?? '';

  if (Array.isArray(parent)) {
    return applyArray(target, segments.slice(0, -1), parent, key, patch);
  }
  if (isPlainObject(parent)) {
    return applyObject(target, segments.slice(0, -1), parent, key, patch);
  }
  throw new Error(`parent at '${segments.slice(0, -1).join('/')}' is not an object or array`);
}

function applyArray(
  root: unknown,
  parentPath: string[],
  parent: unknown[],
  rawKey: string,
  patch: JsonPatch,
): unknown {
  const op = patch.op;

  if (rawKey === '-') {
    if (op !== 'add') {
      throw new Error(`'-' index only valid for add (got ${op})`);
    }
    parent.push(patch.value);
    return root;
  }

  if (!/^\d+$/.test(rawKey)) {
    throw new Error(`array index must be non-negative integer (got '${rawKey}')`);
  }
  const idx = Number(rawKey);

  if (op === 'add') {
    if (idx > parent.length) {
      throw new Error(`add index ${idx} out of bounds for array of length ${parent.length}`);
    }
    parent.splice(idx, 0, patch.value);
    return root;
  }
  if (op === 'replace') {
    if (idx >= parent.length) {
      throw new Error(`replace index ${idx} out of bounds for array of length ${parent.length}`);
    }
    parent[idx] = patch.value;
    return root;
  }
  // remove
  if (idx >= parent.length) {
    throw new Error(`remove index ${idx} out of bounds for array of length ${parent.length}`);
  }
  parent.splice(idx, 1);
  return root;
}

function applyObject(
  root: unknown,
  _parentPath: string[],
  parent: Record<string, unknown>,
  key: string,
  patch: JsonPatch,
): unknown {
  const op = patch.op;

  if (op === 'add' || op === 'replace') {
    parent[key] = patch.value;
    return root;
  }
  // remove
  if (!(key in parent)) {
    throw new Error(`cannot remove '${key}' — key does not exist`);
  }
  delete parent[key];
  return root;
}

function traverse(target: unknown, segments: string[]): unknown {
  let current: unknown = target;
  for (const seg of segments) {
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(seg)) {
        throw new Error(`array index must be non-negative integer (got '${seg}')`);
      }
      const idx = Number(seg);
      if (idx >= current.length) {
        throw new Error(`array index ${idx} out of bounds`);
      }
      current = current[idx];
    } else if (isPlainObject(current)) {
      if (!(seg in current)) {
        throw new Error(`key '${seg}' does not exist`);
      }
      current = current[seg];
    } else {
      throw new Error(`cannot traverse into non-container value at '${seg}'`);
    }
  }
  return current;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
