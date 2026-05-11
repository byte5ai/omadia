// -----------------------------------------------------------------------------
// B.11-8: OpenAPI 3 → ToolSpec[] mapper.
//
// Best-effort 80%-coverage mapper. Each operation in `paths.<path>.<method>`
// becomes a tool: operationId → tool.id (snake_case-coerced), summary or
// description → tool.description, parameters + requestBody.json.schema →
// merged top-level object input schema.
//
// Out-of-scope: $ref resolution across files, polymorphic schemas (oneOf/
// anyOf/allOf), discriminator-based unions, OAuth security flows. Edge
// cases surface as `unsupported` import-errors so the operator can paste
// them manually via the raw-JSON path.
// -----------------------------------------------------------------------------

import type { ToolSpec } from './builderTypes';

export interface ImportError {
  path: string;
  reason: string;
}

export interface ImportResult {
  tools: ToolSpec[];
  errors: ImportError[];
}

interface OpenAPIRoot {
  openapi?: string;
  swagger?: string;
  paths?: Record<string, OpenAPIPath>;
  components?: { schemas?: Record<string, unknown> };
}

interface OpenAPIPath {
  parameters?: ReadonlyArray<OpenAPIParameter>;
  [method: string]: OpenAPIOperation | ReadonlyArray<OpenAPIParameter> | unknown;
}

interface OpenAPIOperation {
  operationId?: string;
  summary?: string;
  description?: string;
  parameters?: ReadonlyArray<OpenAPIParameter>;
  requestBody?: {
    required?: boolean;
    content?: Record<string, { schema?: Record<string, unknown> }>;
  };
}

interface OpenAPIParameter {
  name: string;
  in: 'query' | 'path' | 'header' | 'cookie';
  required?: boolean;
  description?: string;
  schema?: Record<string, unknown>;
}

const HTTP_METHODS = [
  'get',
  'post',
  'put',
  'patch',
  'delete',
  'head',
  'options',
] as const;

export function mapOpenAPI(spec: unknown): ImportResult {
  const errors: ImportError[] = [];
  const tools: ToolSpec[] = [];
  const root = spec as OpenAPIRoot | undefined;
  if (!root || typeof root !== 'object') {
    return {
      tools: [],
      errors: [{ path: '<root>', reason: 'Kein OpenAPI-Root-Objekt' }],
    };
  }
  if (!root.openapi && !root.swagger) {
    errors.push({ path: '<root>', reason: 'openapi/swagger-Version fehlt' });
  }
  if (!root.paths) {
    errors.push({ path: '<root>', reason: 'paths fehlt' });
    return { tools, errors };
  }

  const usedIds = new Set<string>();
  for (const [pathKey, pathItem] of Object.entries(root.paths)) {
    if (!pathItem || typeof pathItem !== 'object') continue;
    const sharedParams =
      (pathItem.parameters as ReadonlyArray<OpenAPIParameter> | undefined) ??
      [];
    for (const method of HTTP_METHODS) {
      const op = pathItem[method] as OpenAPIOperation | undefined;
      if (!op || typeof op !== 'object') continue;
      try {
        const tool = mapOperation(method, pathKey, op, sharedParams, usedIds);
        usedIds.add(tool.id);
        tools.push(tool);
      } catch (err) {
        errors.push({
          path: `${method.toUpperCase()} ${pathKey}`,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
  return { tools, errors };
}

function mapOperation(
  method: string,
  pathKey: string,
  op: OpenAPIOperation,
  sharedParams: ReadonlyArray<OpenAPIParameter>,
  usedIds: ReadonlySet<string>,
): ToolSpec {
  const baseId =
    op.operationId && op.operationId.length > 0
      ? snakeCase(op.operationId)
      : snakeCase(`${method}_${pathKey.replace(/^\//, '')}`);
  const id = uniqueId(baseId, usedIds);
  const description = (op.summary || op.description || '').trim();
  if (!description) {
    throw new Error('weder summary noch description gesetzt');
  }

  const allParams = [...sharedParams, ...(op.parameters ?? [])];
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const p of allParams) {
    if (!p || typeof p !== 'object' || typeof p.name !== 'string') continue;
    const key = snakeCase(p.name);
    properties[key] = sanitizeSchema(p.schema, p.description);
    if (p.required) required.push(key);
  }

  const jsonBody = op.requestBody?.content?.['application/json']?.schema;
  if (jsonBody && typeof jsonBody === 'object') {
    const bodyShape = jsonBody as {
      type?: unknown;
      properties?: Record<string, unknown>;
      required?: ReadonlyArray<string>;
    };
    if (bodyShape.type === 'object' && bodyShape.properties) {
      for (const [k, v] of Object.entries(bodyShape.properties)) {
        if (Object.prototype.hasOwnProperty.call(properties, k)) continue;
        properties[k] = sanitizeSchema(v, undefined);
      }
      if (Array.isArray(bodyShape.required)) {
        for (const r of bodyShape.required) {
          if (!required.includes(r)) required.push(r);
        }
      }
    } else {
      // Non-object body — surface as a single `body` property.
      properties['body'] = sanitizeSchema(jsonBody, 'Request body');
      if (op.requestBody?.required) required.push('body');
    }
  }

  return {
    id,
    description,
    input: {
      type: 'object',
      properties,
      required,
    },
  };
}

const SAFE_SCHEMA_KEYS = new Set([
  'type',
  'description',
  'pattern',
  'format',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'enum',
  'items',
  'properties',
  'required',
]);

function sanitizeSchema(
  schema: unknown,
  description: string | undefined,
): Record<string, unknown> {
  if (!schema || typeof schema !== 'object') {
    return description
      ? { type: 'string', description }
      : { type: 'string' };
  }
  const src = schema as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(src)) {
    if (SAFE_SCHEMA_KEYS.has(key)) {
      out[key] = src[key];
    }
  }
  if (description && typeof out['description'] !== 'string') {
    out['description'] = description;
  }
  if (typeof out['type'] !== 'string') {
    // Default unknown leaves to string so downstream form view stays sane.
    out['type'] = 'string';
  }
  return out;
}

function snakeCase(input: string): string {
  return input
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

function uniqueId(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  let n = 2;
  let candidate = `${base}_${String(n)}`;
  while (taken.has(candidate)) {
    n += 1;
    candidate = `${base}_${String(n)}`;
  }
  return candidate;
}

// ---------------------------------------------------------------------------
// JSON-Schema-Array — direct list of { id, description, input } records.
// Used as a low-level path when OpenAPI doesn't fit (e.g. internal JSON-RPC).
// ---------------------------------------------------------------------------

export function mapJsonSchemaArray(input: unknown): ImportResult {
  const errors: ImportError[] = [];
  if (!Array.isArray(input)) {
    return {
      tools: [],
      errors: [{ path: '<root>', reason: 'Kein Array' }],
    };
  }
  const usedIds = new Set<string>();
  const tools: ToolSpec[] = [];
  input.forEach((entry, i) => {
    if (!entry || typeof entry !== 'object') {
      errors.push({ path: `[${String(i)}]`, reason: 'Kein Objekt' });
      return;
    }
    const e = entry as { id?: unknown; description?: unknown; input?: unknown };
    if (typeof e.id !== 'string' || e.id.length === 0) {
      errors.push({ path: `[${String(i)}]`, reason: 'id fehlt oder ist nicht string' });
      return;
    }
    if (typeof e.description !== 'string' || e.description.length === 0) {
      errors.push({
        path: `[${String(i)}]`,
        reason: 'description fehlt oder ist nicht string',
      });
      return;
    }
    const id = uniqueId(snakeCase(e.id), usedIds);
    usedIds.add(id);
    const tool: ToolSpec = {
      id,
      description: e.description,
      input:
        e.input && typeof e.input === 'object'
          ? (e.input as Record<string, unknown>)
          : { type: 'object', properties: {}, required: [] },
    };
    tools.push(tool);
  });
  return { tools, errors };
}
