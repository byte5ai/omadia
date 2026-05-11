// -----------------------------------------------------------------------------
// Helpers for the JSON-Schema shapes the ToolInputSchemaBuilder edits.
//
// We keep the shape small and JSON-Schema-Draft-2020-12-compatible —
// matches what the middleware ToolSpecSchema accepts (z.object().passthrough()
// — see middleware/src/plugins/builder/agentSpec.ts:48). Anything below
// ('oneOf', '$ref', polymorphic) is out of the form's primary path; the
// raw-JSON-tab in B.11-4 takes those over.
// -----------------------------------------------------------------------------

export type PrimitiveType = 'string' | 'number' | 'integer' | 'boolean';
export type SupportedType = PrimitiveType | 'enum' | 'array' | 'object';

export interface JsonSchemaNode {
  type?: string;
  description?: string;
  // string-only constraints
  pattern?: string;
  format?: string;
  minLength?: number;
  maxLength?: number;
  // number/integer constraints
  minimum?: number;
  maximum?: number;
  // enum (we surface as enum-of-strings; richer enums via raw-JSON)
  enum?: ReadonlyArray<unknown>;
  // array
  items?: JsonSchemaNode;
  // object
  properties?: Record<string, JsonSchemaNode>;
  required?: ReadonlyArray<string>;
  // Anything we don't surface — preserved on edit so users don't lose work.
  [extra: string]: unknown;
}

export const EMPTY_OBJECT_SCHEMA: JsonSchemaNode = {
  type: 'object',
  properties: {},
  required: [],
};

export function ensureTopLevelObject(
  raw: Record<string, unknown> | undefined,
): JsonSchemaNode {
  const node = (raw as JsonSchemaNode | undefined) ?? {};
  if (node.type !== 'object') {
    return {
      ...node,
      type: 'object',
      properties: (node.properties as Record<string, JsonSchemaNode>) ?? {},
      required: Array.isArray(node.required) ? node.required : [],
    };
  }
  return {
    ...node,
    properties: (node.properties as Record<string, JsonSchemaNode>) ?? {},
    required: Array.isArray(node.required) ? node.required : [],
  };
}

export function detectType(node: JsonSchemaNode): SupportedType {
  if (Array.isArray(node.enum)) return 'enum';
  switch (node.type) {
    case 'string':
    case 'number':
    case 'integer':
    case 'boolean':
    case 'object':
    case 'array':
      return node.type;
    default:
      return 'string';
  }
}

/** Returns a fresh node body for a chosen type. Mutating the existing
 *  node would otherwise leave stale constraints (e.g. minLength on a
 *  number field). */
export function blankNodeForType(t: SupportedType): JsonSchemaNode {
  switch (t) {
    case 'string':
      return { type: 'string' };
    case 'number':
      return { type: 'number' };
    case 'integer':
      return { type: 'integer' };
    case 'boolean':
      return { type: 'boolean' };
    case 'enum':
      return { type: 'string', enum: [] };
    case 'array':
      return { type: 'array', items: { type: 'string' } };
    case 'object':
      return { type: 'object', properties: {}, required: [] };
  }
}

export const PROPERTY_KEY_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export function isValidPropertyKey(k: string): boolean {
  return k.length > 0 && PROPERTY_KEY_PATTERN.test(k);
}
