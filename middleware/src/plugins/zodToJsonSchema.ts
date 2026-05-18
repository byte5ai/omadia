import type { z } from 'zod';

/**
 * Zod → JSON-Schema converter for agent tool inputs.
 *
 * Covers the set Claude needs for structured tool-use plus the types that
 * plugin authors realistically reach for:
 *   ZodObject, ZodString, ZodNumber, ZodBoolean, ZodEnum, ZodLiteral,
 *   ZodArray, ZodOptional, ZodNullable, ZodDefault, ZodEffects,
 *   ZodUnion, ZodDiscriminatedUnion, ZodIntersection, ZodRecord, ZodTuple,
 *   ZodAny, ZodUnknown.
 *
 * Anything still unknown falls back to a free-form `{}` schema — valid for
 * Anthropic tool_use, but the model gets less structural signal. The
 * previous iteration of this file also fell through `{}` for union/record/
 * tuple, which made plugins with those shapes materially worse tool-users
 * than built-ins. That gap closes here. The fallback branch warns loudly
 * with diagnostic context (typeName, ctor.name, _def presence) so the next
 * surface of an unknown type is immediately actionable.
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

/**
 * Zod 4 internal shape. Field names diverge from Zod 3:
 *   - `typeName` ("ZodObject") → `type` ("object")
 *   - `shape()` (function)     → `shape` (direct object)
 *   - array element via `type`  → `element`
 *   - effects/transform        → `pipe` (with `in`/`out`)
 *   - literal `value`          → `values: [v]`
 *   - default factory          → `defaultValue` (primitive)
 *   - check objects wrap defs as `_zod.def.{check, format, value, ...}`
 *
 * The walker discriminates on `def.type` (Zod 4) with a fallback to the
 * legacy `typeName` so external plugins still on Zod 3 keep working.
 */
interface ZodCheckV4 {
  _zod?: {
    def?: {
      check?: string;
      format?: string;
      pattern?: RegExp;
      value?: number;
      minimum?: number;
      maximum?: number;
      inclusive?: boolean;
    };
  };
}

interface ZodDef {
  /** Zod 4 discriminator (lowercase): 'object' | 'string' | 'union' | ... */
  type?: string;
  /** Zod 3 discriminator (PascalCase): 'ZodObject' | 'ZodString' | ... */
  typeName?: string;
  checks?: Array<ZodCheckV4 & Record<string, unknown>>;
  description?: string;
  /** Zod 3 enum values. */
  values?: ReadonlyArray<string>;
  /** Zod 4 enum entries (record form). */
  entries?: Record<string, string | number>;
  innerType?: z.ZodTypeAny;
  /** Zod 4 default value (primitive, not factory). */
  defaultValue?: unknown;
  /** Zod 3 default value factory. */
  defaultValueFactory?: () => unknown;
  /** Zod 4 object shape (direct object). */
  shape?: Record<string, z.ZodTypeAny> | (() => Record<string, z.ZodTypeAny>);
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
  // Zod 4 array element / pipe legs:
  element?: z.ZodTypeAny;
  in?: z.ZodTypeAny;
  out?: z.ZodTypeAny;
}

/**
 * Normalise the type tag to the Zod-3 PascalCase form used by the switch.
 * Maps Zod-4 `def.type` strings onto the same labels so the body below
 * stays single-source.
 */
function tagOf(def: ZodDef): string | undefined {
  if (def.typeName) return def.typeName;
  switch (def.type) {
    case 'object': return 'ZodObject';
    case 'string': return 'ZodString';
    case 'number': return 'ZodNumber';
    case 'boolean': return 'ZodBoolean';
    case 'enum': return 'ZodEnum';
    case 'literal': return 'ZodLiteral';
    case 'array': return 'ZodArray';
    case 'optional': return 'ZodOptional';
    case 'nullable': return 'ZodNullable';
    case 'default': return 'ZodDefault';
    case 'pipe': return 'ZodEffects';
    case 'union': return def.discriminator ? 'ZodDiscriminatedUnion' : 'ZodUnion';
    case 'intersection': return 'ZodIntersection';
    case 'record': return 'ZodRecord';
    case 'tuple': return 'ZodTuple';
    case 'any': return 'ZodAny';
    case 'unknown': return 'ZodUnknown';
    default: return undefined;
  }
}

function resolveShape(def: ZodDef): Record<string, z.ZodTypeAny> {
  if (!def.shape) return {};
  return typeof def.shape === 'function' ? def.shape() : def.shape;
}

function checkKind(check: ZodCheckV4 & Record<string, unknown>): string | undefined {
  const v4 = check._zod?.def?.check;
  if (v4) return v4;
  return check['kind'] as string | undefined;
}

function checkV4(check: ZodCheckV4 & Record<string, unknown>): NonNullable<NonNullable<ZodCheckV4['_zod']>['def']> | undefined {
  return check._zod?.def;
}

function defOf(schema: z.ZodTypeAny): ZodDef {
  return (schema as unknown as { _def: ZodDef })._def;
}

function isOptional(schema: z.ZodTypeAny): boolean {
  const def = defOf(schema);
  const tag = tagOf(def);
  if (tag === 'ZodOptional' || tag === 'ZodDefault') return true;
  if (tag === 'ZodNullable' && def.innerType) return isOptional(def.innerType);
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
  // Zod 4 moved descriptions off `_def.description` onto the schema instance
  // (via `.describe()` and the `meta()` accessor). Zod 3 kept it on `_def`.
  // Read from both so this works under either runtime.
  const description =
    (schema as { description?: string }).description ?? def.description;
  const base = convert(schema, def);
  if (description && !base.description) base.description = description;
  return base;
}

function convert(schema: z.ZodTypeAny, def: ZodDef): JsonSchema {
  const tag = tagOf(def);
  switch (tag) {
    case 'ZodObject': {
      const shape = resolveShape(def);
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
        const v4 = checkV4(check);
        const kind = checkKind(check);
        // Zod 4: string-format lives under check='string_format' + format='url'|'email'|...
        if (v4?.check === 'string_format') {
          const fmt = v4.format;
          if (fmt === 'url') out.format = 'uri';
          else if (fmt === 'email') out.format = 'email';
          else if (fmt === 'uuid') out.format = 'uuid';
          else if (fmt === 'regex' && v4.pattern instanceof RegExp) {
            out.pattern = v4.pattern.source;
          }
          continue;
        }
        if (v4?.check === 'min_length') {
          out.minLength = v4.minimum;
          continue;
        }
        if (v4?.check === 'max_length') {
          out.maxLength = v4.maximum;
          continue;
        }
        // Zod 3 fallback (in case a plugin still ships v3 schemas).
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
        const v4 = checkV4(check);
        const kind = checkKind(check);
        // Zod 4: `int()` is encoded as `number_format` with `format='safeint'`.
        if (v4?.check === 'number_format' && v4.format === 'safeint') {
          out.type = 'integer';
          continue;
        }
        if (v4?.check === 'greater_than') {
          out.minimum = v4.value;
          continue;
        }
        if (v4?.check === 'less_than') {
          out.maximum = v4.value;
          continue;
        }
        // Zod 3 fallback.
        if (kind === 'int') out.type = 'integer';
        else if (kind === 'min') out.minimum = check['value'] as number;
        else if (kind === 'max') out.maximum = check['value'] as number;
      }
      return out;
    }
    case 'ZodBoolean':
      return { type: 'boolean' };
    case 'ZodEnum': {
      // Zod 4: `def.entries` is `{ key: value }`; values are the user-facing
      // strings. Zod 3: `def.values` is the array.
      const values = def.entries
        ? (Object.values(def.entries) as unknown as string[])
        : ((def.values ?? []) as unknown as string[]);
      return { type: 'string', enum: values };
    }
    case 'ZodArray': {
      // Zod 4 stores the element in `def.element`; Zod 3 used `def.type`
      // (a `z.ZodTypeAny`). The `ZodDef.type` field is now a string in v4,
      // so the v3 path needs the legacy interpretation via a cast.
      const v4Element = def.element;
      const v3Element = (def as unknown as { type?: z.ZodTypeAny }).type;
      const element =
        v4Element ?? (typeof v3Element === 'object' ? v3Element : undefined);
      return {
        type: 'array',
        items: element ? zodToJsonSchema(element) : {},
      };
    }
    case 'ZodOptional':
    case 'ZodNullable':
      return def.innerType ? zodToJsonSchema(def.innerType) : {};
    case 'ZodDefault': {
      const inner = def.innerType ? zodToJsonSchema(def.innerType) : {};
      try {
        // Zod 4: `defaultValue` is a primitive. Zod 3: factory function.
        if (typeof def.defaultValue === 'function') {
          inner.default = (def.defaultValue as () => unknown)();
        } else if (def.defaultValue !== undefined) {
          inner.default = def.defaultValue;
        }
      } catch {
        // defaultValue factory may throw — schema stays valid without a default.
      }
      return inner;
    }
    case 'ZodLiteral': {
      // Zod 4: `def.values = [v]`. Zod 3: `def.value = v`.
      const literal =
        def.values && def.values.length > 0
          ? def.values[0]
          : (def as unknown as { value?: unknown }).value;
      if (typeof literal === 'string') return { type: 'string', enum: [literal] };
      if (typeof literal === 'number') return { type: 'number', enum: [literal] };
      if (typeof literal === 'boolean') return { type: 'boolean', enum: [literal] };
      return {};
    }
    case 'ZodEffects': {
      // Zod 4 collapses transforms into pipes: `def.in` is the input schema.
      // Zod 3 had `def.schema`.
      const inner =
        def.in ?? (def as unknown as { schema?: z.ZodTypeAny }).schema;
      return inner ? zodToJsonSchema(inner) : {};
    }

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

    case 'ZodAny':
    case 'ZodUnknown':
      // Free-form payload — Anthropic tool-use accepts an empty object schema
      // as "any JSON value". No structural hint to give the model, but at
      // least don't trip the fallback warning below.
      return {};

    default: {
      // Unknown type — leave as free-form object so the model at least receives
      // a valid schema. Log loudly so the next encounter surfaces the missing
      // case instead of silently delivering an empty parameter list. Diagnostic
      // helps trap module-boundary issues (plugin loads its own `zod` whose
      // typeName/type somehow differs) and exotic new Zod types added by
      // plugins.
      const typeName = def.typeName ?? def.type ?? '(no typeName)';
      const hasUnderscoreDef =
        schema != null && typeof schema === 'object' && '_def' in schema;
      const constructorName =
        (schema as { constructor?: { name?: string } } | null)?.constructor
          ?.name ?? '(unknown)';
      console.warn(
        `[zodToJsonSchema] FALLBACK — unrecognised Zod type. ` +
          `typeName='${typeName}' ctor='${constructorName}' hasUnderscoreDef=${String(hasUnderscoreDef)}. ` +
          `Returning {} schema; the model will see no parameters.`,
      );
      return {};
    }
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
