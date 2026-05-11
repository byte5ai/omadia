/**
 * Synthetic-Input-Generator (B.9-2) — produces a minimal value that
 * passes a tool's `input` JSON-schema, used by RuntimeSmoke to invoke
 * each tool with something validation-shaped instead of `{}`. Walks
 * the schema and picks deterministic defaults:
 *
 *   string  → "test"            (or enum_values[0] if enum)
 *   number  → schema.minimum ?? 1
 *   integer → schema.minimum ?? 1
 *   boolean → true
 *   null    → null
 *   array   → [] (or [generateForItem] if minItems > 0)
 *   object  → walk required[] + .properties
 *
 * Anything unrecognised → null + warning via the optional `onUnknown`
 * callback. The generator is deterministic — same schema in, same
 * value out — so smoke-test results stay reproducible.
 *
 * NOT a general-purpose faker. Output values are picked to satisfy
 * required-field semantics ONLY; they don't try to represent realistic
 * domain data. Behaviour-quality testing is B.10's job.
 */

export interface GenerateOptions {
  /** Cap recursion depth for nested objects/arrays. Default 6. */
  maxDepth?: number;
  /** Called once per unrecognised schema fragment. Useful for tests + telemetry. */
  onUnknown?: (path: string, schema: unknown) => void;
}

export function generateInputForSchema(
  schema: unknown,
  opts: GenerateOptions = {},
): unknown {
  const maxDepth = opts.maxDepth ?? 6;
  return walk(schema, '', 0, maxDepth, opts.onUnknown);
}

function walk(
  schema: unknown,
  path: string,
  depth: number,
  maxDepth: number,
  onUnknown?: (path: string, schema: unknown) => void,
): unknown {
  if (depth > maxDepth) return null;
  if (!schema || typeof schema !== 'object') {
    onUnknown?.(path, schema);
    return null;
  }

  const s = schema as Record<string, unknown>;

  // Enum wins regardless of `type` — pick first enum value.
  if (Array.isArray(s['enum']) && s['enum'].length > 0) {
    return s['enum'][0];
  }

  // anyOf / oneOf — pick first branch that resolves to something.
  for (const key of ['anyOf', 'oneOf'] as const) {
    const branches = s[key];
    if (Array.isArray(branches) && branches.length > 0) {
      return walk(branches[0], `${path}.${key}[0]`, depth + 1, maxDepth, onUnknown);
    }
  }

  // allOf — fold all branches; later overrides earlier.
  if (Array.isArray(s['allOf'])) {
    let merged: Record<string, unknown> = {};
    for (let i = 0; i < s['allOf'].length; i += 1) {
      const branch = walk(
        s['allOf'][i],
        `${path}.allOf[${String(i)}]`,
        depth + 1,
        maxDepth,
        onUnknown,
      );
      if (branch && typeof branch === 'object' && !Array.isArray(branch)) {
        merged = { ...merged, ...(branch as Record<string, unknown>) };
      }
    }
    return merged;
  }

  const type = s['type'];
  if (typeof type === 'string') {
    return generateByType(type, s, path, depth, maxDepth, onUnknown);
  }

  // No `type` — try to infer from `properties` (object shorthand).
  if (typeof s['properties'] === 'object') {
    return generateByType('object', s, path, depth, maxDepth, onUnknown);
  }
  if (Array.isArray(s['items'])) {
    return generateByType('array', s, path, depth, maxDepth, onUnknown);
  }

  onUnknown?.(path, schema);
  return null;
}

function generateByType(
  type: string,
  schema: Record<string, unknown>,
  path: string,
  depth: number,
  maxDepth: number,
  onUnknown?: (path: string, schema: unknown) => void,
): unknown {
  switch (type) {
    case 'string': {
      const minLen = typeof schema['minLength'] === 'number' ? schema['minLength'] : 0;
      return minLen > 4 ? 'test'.padEnd(minLen, 'x') : 'test';
    }
    case 'number':
    case 'integer': {
      const min = typeof schema['minimum'] === 'number' ? schema['minimum'] : null;
      if (min !== null && min > 1) return min;
      return 1;
    }
    case 'boolean':
      return true;
    case 'null':
      return null;
    case 'array': {
      const minItems = typeof schema['minItems'] === 'number' ? schema['minItems'] : 0;
      if (minItems === 0) return [];
      const items = schema['items'];
      const sample = walk(items, `${path}[]`, depth + 1, maxDepth, onUnknown);
      return Array.from({ length: minItems }, () => sample);
    }
    case 'object': {
      const props = schema['properties'];
      const required = Array.isArray(schema['required']) ? schema['required'] : [];
      const out: Record<string, unknown> = {};
      if (props && typeof props === 'object') {
        for (const reqKey of required) {
          if (typeof reqKey !== 'string') continue;
          const subSchema = (props as Record<string, unknown>)[reqKey];
          out[reqKey] = walk(
            subSchema,
            `${path}.${reqKey}`,
            depth + 1,
            maxDepth,
            onUnknown,
          );
        }
      }
      return out;
    }
    default:
      onUnknown?.(path, schema);
      return null;
  }
}
