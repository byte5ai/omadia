import type { z } from 'zod';

/**
 * Zod → JSON-Schema converter for agent tool inputs.
 *
 * Covers the set Claude needs for structured tool-use plus the types that
 * plugin authors realistically reach for:
 *   ZodObject, ZodString, ZodNumber, ZodBoolean, ZodEnum, ZodLiteral,
 *   ZodArray, ZodOptional, ZodNullable, ZodDefault, ZodEffects,
 *   ZodUnion, ZodDiscriminatedUnion, ZodIntersection, ZodRecord, ZodTuple.
 *
 * Anything still unknown falls back to a free-form `{}` schema — valid for
 * Anthropic tool_use, but the model gets less structural signal. The
 * previous iteration of this file also fell through `{}` for union/record/
 * tuple, which made plugins with those shapes materially worse tool-users
 * than built-ins. That gap closes here.
 */

export interface JsonSchema {
  type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null';
  description?: string;
  format?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  pattern?: string;
  enum?: Array<string | number | boolean>;
  items?: JsonSchema;
  /** Draft 2020-12 — tuple prefix items (first N positions typed). */
  prefixItems?: JsonSchema[];
  minItems?: number;
  maxItems?: number;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  /** Either a boolean gate (object closed/open) or a schema for the
   *  catch-all values (ZodRecord). */
  additionalProperties?: boolean | JsonSchema;
  default?: unknown;
  /** Union (lenient — matches any). */
  anyOf?: JsonSchema[];
  /** Discriminated union (exactly one). */
  oneOf?: JsonSchema[];
  /** Intersection. */
  allOf?: JsonSchema[];
}

interface ZodDef {
  typeName?: string;
  checks?: Array<Record<string, unknown>>;
  description?: string;
  values?: ReadonlyArray<string>;
  innerType?: z.ZodTypeAny;
  type?: z.ZodTypeAny;
  defaultValue?: () => unknown;
  shape?: () => Record<string, z.ZodTypeAny>;
  // Union-ish:
  options?: ReadonlyArray<z.ZodTypeAny> | Map<unknown, z.ZodTypeAny>;
  discriminator?: string;
  // Intersection:
  left?: z.ZodTypeAny;
  right?: z.ZodTypeAny;
  // Record:
  keyType?: z.ZodTypeAny;
  valueType?: z.ZodTypeAny;
  // Tuple:
  items?: ReadonlyArray<z.ZodTypeAny>;
  rest?: z.ZodTypeAny | null;
}

function defOf(schema: z.ZodTypeAny): ZodDef {
  return (schema as unknown as { _def: ZodDef })._def;
}

function isOptional(schema: z.ZodTypeAny): boolean {
  const def = defOf(schema);
  if (def.typeName === 'ZodOptional' || def.typeName === 'ZodDefault') return true;
  if (def.typeName === 'ZodNullable' && def.innerType) return isOptional(def.innerType);
  if (typeof (schema as { isOptional?: () => boolean }).isOptional === 'function') {
    try {
      return (schema as { isOptional: () => boolean }).isOptional();
    } catch {
      return false;
    }
  }
  return false;
}

export function zodToJsonSchema(schema: z.ZodTypeAny): JsonSchema {
  const def = defOf(schema);
  const description = def.description;
  const base = convert(schema, def);
  if (description && !base.description) base.description = description;
  return base;
}

function convert(schema: z.ZodTypeAny, def: ZodDef): JsonSchema {
  switch (def.typeName) {
    case 'ZodObject': {
      const shape = def.shape?.() ?? {};
      const properties: Record<string, JsonSchema> = {};
      const required: string[] = [];
      for (const [key, child] of Object.entries(shape)) {
        properties[key] = zodToJsonSchema(child);
        if (!isOptional(child)) required.push(key);
      }
      const out: JsonSchema = {
        type: 'object',
        properties,
        additionalProperties: false,
      };
      if (required.length > 0) out.required = required;
      return out;
    }
    case 'ZodString': {
      const out: JsonSchema = { type: 'string' };
      for (const check of def.checks ?? []) {
        const kind = check['kind'];
        if (kind === 'url') out.format = 'uri';
        else if (kind === 'email') out.format = 'email';
        else if (kind === 'uuid') out.format = 'uuid';
        else if (kind === 'min') out.minLength = check['value'] as number;
        else if (kind === 'max') out.maxLength = check['value'] as number;
        else if (kind === 'regex') {
          const re = check['regex'];
          if (re instanceof RegExp) out.pattern = re.source;
        }
      }
      return out;
    }
    case 'ZodNumber': {
      const out: JsonSchema = { type: 'number' };
      for (const check of def.checks ?? []) {
        const kind = check['kind'];
        if (kind === 'int') out.type = 'integer';
        else if (kind === 'min') out.minimum = check['value'] as number;
        else if (kind === 'max') out.maximum = check['value'] as number;
      }
      return out;
    }
    case 'ZodBoolean':
      return { type: 'boolean' };
    case 'ZodEnum':
      return {
        type: 'string',
        enum: (def.values ?? []) as unknown as string[],
      };
    case 'ZodArray':
      return {
        type: 'array',
        items: def.type ? zodToJsonSchema(def.type) : {},
      };
    case 'ZodOptional':
    case 'ZodNullable':
      return def.innerType ? zodToJsonSchema(def.innerType) : {};
    case 'ZodDefault': {
      const inner = def.innerType ? zodToJsonSchema(def.innerType) : {};
      try {
        if (def.defaultValue) inner.default = def.defaultValue();
      } catch {
        // defaultValue factory may throw — schema stays valid without a default.
      }
      return inner;
    }
    case 'ZodLiteral': {
      const literal = (def as unknown as { value: unknown }).value;
      if (typeof literal === 'string') return { type: 'string', enum: [literal] };
      if (typeof literal === 'number') return { type: 'number', enum: [literal] };
      if (typeof literal === 'boolean') return { type: 'boolean', enum: [literal] };
      return {};
    }
    case 'ZodEffects':
      return (def as unknown as { schema: z.ZodTypeAny }).schema
        ? zodToJsonSchema((def as unknown as { schema: z.ZodTypeAny }).schema)
        : {};

    case 'ZodUnion': {
      const branches = unwrapOptions(def.options);
      if (branches.length === 0) return {};
      // Collapse branches that produce identical `{type, enum}` into a single
      // enum — a common pattern (z.union([z.literal('a'), z.literal('b')])).
      const converted = branches.map((b) => zodToJsonSchema(b));
      const collapsedEnum = tryCollapseEnum(converted);
      if (collapsedEnum) return collapsedEnum;
      return { anyOf: converted };
    }

    case 'ZodDiscriminatedUnion': {
      const branches = unwrapOptions(def.options);
      if (branches.length === 0) return {};
      return { oneOf: branches.map((b) => zodToJsonSchema(b)) };
    }

    case 'ZodIntersection': {
      const parts: JsonSchema[] = [];
      if (def.left) parts.push(zodToJsonSchema(def.left));
      if (def.right) parts.push(zodToJsonSchema(def.right));
      if (parts.length === 0) return {};
      return { allOf: parts };
    }

    case 'ZodRecord': {
      const valueSchema = def.valueType ? zodToJsonSchema(def.valueType) : {};
      return {
        type: 'object',
        additionalProperties: valueSchema,
      };
    }

    case 'ZodTuple': {
      const items = def.items ?? [];
      const prefix = items.map((t) => zodToJsonSchema(t));
      const out: JsonSchema = {
        type: 'array',
        prefixItems: prefix,
        minItems: prefix.length,
      };
      if (def.rest) {
        out.items = zodToJsonSchema(def.rest);
      } else {
        out.maxItems = prefix.length;
      }
      return out;
    }

    default:
      // Unknown type — leave as free-form object so the model at least receives
      // a valid schema. Surface in the tool's description field when possible.
      return {};
  }
}

/** Zod stores discriminated-union options as Map<discriminatorValue, branch>
 *  in some versions, and as an array in others. Normalise to array. */
function unwrapOptions(
  options: ReadonlyArray<z.ZodTypeAny> | Map<unknown, z.ZodTypeAny> | undefined,
): z.ZodTypeAny[] {
  if (!options) return [];
  if (Array.isArray(options)) return [...options];
  if (options instanceof Map) return Array.from(options.values());
  return [];
}

/** If every branch of a union is `{ type: 'string'|'number'|'boolean',
 *  enum: [literal] }`, merge into a single enum schema. Produces cleaner
 *  output for the common `z.union([z.literal('a'), z.literal('b')])` pattern,
 *  and gives the model a better signal than `anyOf` with singleton enums. */
function tryCollapseEnum(branches: JsonSchema[]): JsonSchema | undefined {
  if (branches.length < 2) return undefined;
  const first = branches[0];
  if (!first?.type || !first.enum || first.enum.length !== 1) return undefined;
  const sharedType = first.type;
  const values: Array<string | number | boolean> = [];
  for (const b of branches) {
    if (b.type !== sharedType) return undefined;
    if (!b.enum || b.enum.length !== 1) return undefined;
    const val = b.enum[0];
    if (val === undefined) return undefined;
    values.push(val);
  }
  return { type: sharedType, enum: values };
}
