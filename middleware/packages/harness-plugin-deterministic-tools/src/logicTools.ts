import { z } from 'zod';

import { defineTool, type DeterministicToolDefinition } from './toolHelper.js';

/**
 * Logic-inference tools — sets, ranges, predicates. Same Postcondition
 * contract as the calculator tools: every return value is validated
 * against a Zod output schema and a mismatch lifts onto the RunTrace as
 * `tool_postcondition`.
 *
 * Scope decision (#128 open question): values are passed RAW (numbers,
 * strings, dates, plain objects). Knowledge-graph node-id refs are NOT
 * supported in v1 — the orchestrator must first resolve nodes via
 * `query_knowledge_graph` and feed the field values into these tools.
 * That keeps every tool side-effect-free and trivially testable.
 */

// --- Shared schemas --------------------------------------------------------

const Primitive = z.union([z.string(), z.number(), z.boolean(), z.null()]);
type Primitive = z.infer<typeof Primitive>;

const PrimitiveJsonSchema = {
  oneOf: [
    { type: 'string' as const },
    { type: 'number' as const },
    { type: 'boolean' as const },
    { type: 'null' as const },
  ],
};

const PrimitiveArrayJsonSchema = {
  type: 'array' as const,
  items: PrimitiveJsonSchema,
};

const IsoDate = z
  .string()
  .refine((s) => !Number.isNaN(Date.parse(s)), {
    message: 'must be an ISO-8601 date or datetime string',
  });

// --- Set operations --------------------------------------------------------

const setIntersection = defineTool({
  name: 'set_intersection',
  description:
    'Schnittmenge zweier Listen — Werte, die in BEIDEN vorkommen. Vergleich ist deep-equal über primitive Werte (string | number | boolean | null). IMMER dieses Tool für UND-Filter über Listen nutzen (z.B. "welche Produkte sind sowohl auf Lager UND im Angebot").',
  inputJsonSchema: {
    type: 'object',
    properties: {
      a: PrimitiveArrayJsonSchema,
      b: PrimitiveArrayJsonSchema,
    },
    required: ['a', 'b'],
  },
  inputZod: z.object({
    a: z.array(Primitive),
    b: z.array(Primitive),
  }),
  outputZod: z.object({
    intersection: z.array(Primitive),
    count: z.number().int().min(0),
  }),
  run({ a, b }) {
    const bSet = new Set(b.map(stableKey));
    const intersection: Primitive[] = [];
    const seen = new Set<string>();
    for (const v of a) {
      const k = stableKey(v);
      if (bSet.has(k) && !seen.has(k)) {
        intersection.push(v);
        seen.add(k);
      }
    }
    return { intersection, count: intersection.length };
  },
});

const setDifference = defineTool({
  name: 'set_difference',
  description:
    'Differenzmenge `a \\ b` — Werte, die in `a`, aber NICHT in `b` vorkommen. IMMER dieses Tool für Ausschluss-Filter nutzen (z.B. "welche Kunden waren letztes Jahr Kunde aber nicht dieses Jahr").',
  inputJsonSchema: {
    type: 'object',
    properties: {
      a: PrimitiveArrayJsonSchema,
      b: PrimitiveArrayJsonSchema,
    },
    required: ['a', 'b'],
  },
  inputZod: z.object({
    a: z.array(Primitive),
    b: z.array(Primitive),
  }),
  outputZod: z.object({
    difference: z.array(Primitive),
    count: z.number().int().min(0),
  }),
  run({ a, b }) {
    const bSet = new Set(b.map(stableKey));
    const difference: Primitive[] = [];
    const seen = new Set<string>();
    for (const v of a) {
      const k = stableKey(v);
      if (!bSet.has(k) && !seen.has(k)) {
        difference.push(v);
        seen.add(k);
      }
    }
    return { difference, count: difference.length };
  },
});

const setSubset = defineTool({
  name: 'set_subset',
  description:
    'Prüft, ob `a` eine Teilmenge von `b` ist (alle Elemente von `a` kommen in `b` vor). IMMER dieses Tool für "Sind alle X auch Y?"-Fragen nutzen.',
  inputJsonSchema: {
    type: 'object',
    properties: {
      a: PrimitiveArrayJsonSchema,
      b: PrimitiveArrayJsonSchema,
    },
    required: ['a', 'b'],
  },
  inputZod: z.object({
    a: z.array(Primitive),
    b: z.array(Primitive),
  }),
  outputZod: z.object({
    is_subset: z.boolean(),
    missing: z.array(Primitive),
  }),
  run({ a, b }) {
    const bSet = new Set(b.map(stableKey));
    const missing: Primitive[] = [];
    for (const v of a) {
      if (!bSet.has(stableKey(v))) missing.push(v);
    }
    return { is_subset: missing.length === 0, missing };
  },
});

// --- Range checks ----------------------------------------------------------

const rangeCheckNumber = defineTool({
  name: 'range_check_number',
  description:
    'Prüft, ob `value` im Intervall `[min, max]` liegt. `min` oder `max` weglassen für offene Intervalle. IMMER dieses Tool für "Ist X zwischen A und B?"-Fragen nutzen.',
  inputJsonSchema: {
    type: 'object',
    properties: {
      value: { type: 'number' },
      min: { type: 'number' },
      max: { type: 'number' },
    },
    required: ['value'],
  },
  inputZod: z.object({
    value: z.number(),
    min: z.number().optional(),
    max: z.number().optional(),
  }),
  outputZod: z.object({
    in_range: z.boolean(),
    reason: z.string(),
  }),
  run({ value, min, max }) {
    if (min !== undefined && value < min) {
      return { in_range: false, reason: `${value} < min=${min}` };
    }
    if (max !== undefined && value > max) {
      return { in_range: false, reason: `${value} > max=${max}` };
    }
    return { in_range: true, reason: 'within range' };
  },
});

const rangeCheckDate = defineTool({
  name: 'range_check_date',
  description:
    'Prüft, ob `value` (ISO-Datum oder ISO-Datetime) zwischen `from` und `to` liegt. `from`/`to` weglassen für offene Intervalle. IMMER dieses Tool für Datums-Vergleiche nutzen, statt inline Datumsvergleiche zu machen.',
  inputJsonSchema: {
    type: 'object',
    properties: {
      value: { type: 'string', description: 'ISO-8601 date or datetime' },
      from: { type: 'string', description: 'ISO-8601 date or datetime' },
      to: { type: 'string', description: 'ISO-8601 date or datetime' },
    },
    required: ['value'],
  },
  inputZod: z.object({
    value: IsoDate,
    from: IsoDate.optional(),
    to: IsoDate.optional(),
  }),
  outputZod: z.object({
    in_range: z.boolean(),
    reason: z.string(),
  }),
  run({ value, from, to }) {
    const v = Date.parse(value);
    if (from !== undefined) {
      const f = Date.parse(from);
      if (v < f) return { in_range: false, reason: `${value} < from=${from}` };
    }
    if (to !== undefined) {
      const t = Date.parse(to);
      if (v > t) return { in_range: false, reason: `${value} > to=${to}` };
    }
    return { in_range: true, reason: 'within range' };
  },
});

// --- Predicate eval --------------------------------------------------------

const predicateEval = defineTool({
  name: 'predicate_eval',
  description:
    'Prüft, ob ein Record alle gegebenen Bedingungen erfüllt. Operatoren: `eq`, `ne`, `lt`, `le`, `gt`, `ge`, `in`, `not_in`. Liefert die Liste der fehlgeschlagenen Bedingungen mit Detail. IMMER dieses Tool nutzen, statt mehrere if/else-Fragen inline zu beurteilen.',
  inputJsonSchema: {
    type: 'object',
    properties: {
      record: { type: 'object', additionalProperties: true },
      conditions: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          properties: {
            field: { type: 'string' },
            op: {
              type: 'string',
              enum: ['eq', 'ne', 'lt', 'le', 'gt', 'ge', 'in', 'not_in'],
            },
            value: {},
          },
          required: ['field', 'op', 'value'],
        },
      },
    },
    required: ['record', 'conditions'],
  },
  inputZod: z.object({
    record: z.record(z.string(), z.unknown()),
    conditions: z
      .array(
        z.object({
          field: z.string().min(1),
          op: z.enum(['eq', 'ne', 'lt', 'le', 'gt', 'ge', 'in', 'not_in']),
          value: z.unknown(),
        }),
      )
      .min(1),
  }),
  outputZod: z.object({
    matches: z.boolean(),
    failed: z.array(
      z.object({
        field: z.string(),
        op: z.string(),
        expected: z.unknown(),
        actual: z.unknown(),
      }),
    ),
  }),
  run({ record, conditions }) {
    const failed: {
      field: string;
      op: string;
      expected: unknown;
      actual: unknown;
    }[] = [];
    for (const c of conditions) {
      const actual = record[c.field];
      const ok = evalOp(actual, c.op, c.value);
      if (!ok) {
        failed.push({
          field: c.field,
          op: c.op,
          expected: c.value,
          actual,
        });
      }
    }
    return { matches: failed.length === 0, failed };
  },
});

// --- Lookup table ----------------------------------------------------------

const lookupTable = defineTool({
  name: 'lookup_table',
  description:
    'Schlägt einen Wert in einer Tabelle nach (Map von Key zu Wert). Liefert das Ergebnis und ein found-Flag. IMMER dieses Tool nutzen, statt eine if-Kaskade auf einem festen Mapping zu denken (z.B. ISO-Sprachcode → Sprachname).',
  inputJsonSchema: {
    type: 'object',
    properties: {
      table: { type: 'object', additionalProperties: true },
      key: { type: 'string' },
    },
    required: ['table', 'key'],
  },
  inputZod: z.object({
    table: z.record(z.string(), z.unknown()),
    key: z.string(),
  }),
  outputZod: z.object({
    found: z.boolean(),
    value: z.unknown(),
  }),
  run({ table, key }) {
    if (key in table) {
      return { found: true, value: table[key] };
    }
    return { found: false, value: null };
  },
});

// --- Helpers ---------------------------------------------------------------

function stableKey(v: Primitive): string {
  if (v === null) return '__null__';
  return `${typeof v}:${String(v)}`;
}

function evalOp(actual: unknown, op: string, expected: unknown): boolean {
  switch (op) {
    case 'eq':
      return deepEqual(actual, expected);
    case 'ne':
      return !deepEqual(actual, expected);
    case 'lt':
      return numericCompare(actual, expected, (a, b) => a < b);
    case 'le':
      return numericCompare(actual, expected, (a, b) => a <= b);
    case 'gt':
      return numericCompare(actual, expected, (a, b) => a > b);
    case 'ge':
      return numericCompare(actual, expected, (a, b) => a >= b);
    case 'in':
      return Array.isArray(expected) && expected.some((e) => deepEqual(actual, e));
    case 'not_in':
      return Array.isArray(expected) && !expected.some((e) => deepEqual(actual, e));
    default:
      return false;
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

function numericCompare(
  a: unknown,
  b: unknown,
  cmp: (x: number, y: number) => boolean,
): boolean {
  if (typeof a !== 'number' || typeof b !== 'number') return false;
  return cmp(a, b);
}

// --- Export ----------------------------------------------------------------

export const logicTools: readonly DeterministicToolDefinition[] = [
  setIntersection,
  setDifference,
  setSubset,
  rangeCheckNumber,
  rangeCheckDate,
  predicateEval,
  lookupTable,
];
