import { z } from 'zod';

import { defineTool, type DeterministicToolDefinition } from './toolHelper.js';

/**
 * Numeric precision policy
 * ------------------------
 * v1 uses native `number` (IEEE 754) — fast and stable for sum/sub/mul/div
 * of values within ~15-significant-digit precision, which covers the vast
 * majority of operator-facing arithmetic (counts, durations, percentages,
 * EUR amounts). The trade-off: `0.1 + 0.2` returns `0.30000000000000004`,
 * which is mathematically correct for floating point but surprises users.
 *
 * The orchestrator's prompt-doc (Math-Delegation rule) instructs the LLM
 * to call `calc_round` whenever a presentational decimal precision is
 * needed (currency, percentages). When a future use-case requires
 * arbitrary precision (large-scale invoice rollups, tax computations),
 * a Decimal.js-backed `calc_sum_decimal` tool can be added behind the
 * same Postcondition contract without changing the existing calls.
 */

// --- Schemas ---------------------------------------------------------------

const FiniteNumber = z.number().refine(Number.isFinite, {
  message: 'must be a finite number',
});

const NonEmptyNumberArray = z.array(FiniteNumber).min(1, {
  message: 'values must be a non-empty array',
});

const FiniteNumberJsonSchema = {
  type: 'number' as const,
};

const NonEmptyNumberArrayJsonSchema = {
  type: 'array' as const,
  items: FiniteNumberJsonSchema,
  minItems: 1,
};

// --- Tools -----------------------------------------------------------------

const calcSum = defineTool({
  name: 'calc_sum',
  description:
    'Addiert eine Liste von Zahlen exakt. IMMER dieses Tool für jede Summenbildung nutzen — niemals inline addieren. Auch für 2+2.',
  inputJsonSchema: {
    type: 'object',
    properties: { values: NonEmptyNumberArrayJsonSchema },
    required: ['values'],
  },
  inputZod: z.object({ values: NonEmptyNumberArray }),
  outputZod: z.object({
    sum: FiniteNumber,
    count: z.number().int().min(1),
  }),
  run({ values }) {
    return {
      sum: values.reduce((acc, v) => acc + v, 0),
      count: values.length,
    };
  },
});

const calcSub = defineTool({
  name: 'calc_sub',
  description:
    'Subtrahiert `b` von `a` exakt (`a − b`). IMMER dieses Tool für jede Subtraktion nutzen.',
  inputJsonSchema: {
    type: 'object',
    properties: { a: FiniteNumberJsonSchema, b: FiniteNumberJsonSchema },
    required: ['a', 'b'],
  },
  inputZod: z.object({ a: FiniteNumber, b: FiniteNumber }),
  outputZod: z.object({ difference: FiniteNumber }),
  run({ a, b }) {
    return { difference: a - b };
  },
});

const calcMul = defineTool({
  name: 'calc_mul',
  description:
    'Multipliziert eine Liste von Zahlen exakt. IMMER dieses Tool für jede Multiplikation nutzen.',
  inputJsonSchema: {
    type: 'object',
    properties: { values: NonEmptyNumberArrayJsonSchema },
    required: ['values'],
  },
  inputZod: z.object({ values: NonEmptyNumberArray }),
  outputZod: z.object({
    product: FiniteNumber,
    count: z.number().int().min(1),
  }),
  run({ values }) {
    return {
      product: values.reduce((acc, v) => acc * v, 1),
      count: values.length,
    };
  },
});

const calcDiv = defineTool({
  name: 'calc_div',
  description:
    'Dividiert `a` durch `b` (`a / b`) und liefert Quotient + Rest. Wirft Error bei Division durch 0. IMMER dieses Tool für jede Division nutzen.',
  inputJsonSchema: {
    type: 'object',
    properties: { a: FiniteNumberJsonSchema, b: FiniteNumberJsonSchema },
    required: ['a', 'b'],
  },
  inputZod: z.object({ a: FiniteNumber, b: FiniteNumber }),
  outputZod: z.object({
    quotient: FiniteNumber,
    remainder: FiniteNumber,
  }),
  run({ a, b }) {
    if (b === 0) throw new Error('division by zero');
    return {
      quotient: a / b,
      remainder: a - Math.trunc(a / b) * b,
    };
  },
});

const calcPct = defineTool({
  name: 'calc_pct',
  description:
    '`percent` Prozent von `value` (z.B. value=200, percent=15 → 30). IMMER dieses Tool für jede Prozentrechnung nutzen.',
  inputJsonSchema: {
    type: 'object',
    properties: {
      value: FiniteNumberJsonSchema,
      percent: FiniteNumberJsonSchema,
    },
    required: ['value', 'percent'],
  },
  inputZod: z.object({ value: FiniteNumber, percent: FiniteNumber }),
  outputZod: z.object({ result: FiniteNumber }),
  run({ value, percent }) {
    return { result: (value * percent) / 100 };
  },
});

const calcMin = defineTool({
  name: 'calc_min',
  description:
    'Liefert das Minimum einer Liste von Zahlen. IMMER dieses Tool für Minimum-Bestimmung über >2 Werte nutzen.',
  inputJsonSchema: {
    type: 'object',
    properties: { values: NonEmptyNumberArrayJsonSchema },
    required: ['values'],
  },
  inputZod: z.object({ values: NonEmptyNumberArray }),
  outputZod: z.object({ min: FiniteNumber }),
  run({ values }) {
    return { min: Math.min(...values) };
  },
});

const calcMax = defineTool({
  name: 'calc_max',
  description:
    'Liefert das Maximum einer Liste von Zahlen. IMMER dieses Tool für Maximum-Bestimmung über >2 Werte nutzen.',
  inputJsonSchema: {
    type: 'object',
    properties: { values: NonEmptyNumberArrayJsonSchema },
    required: ['values'],
  },
  inputZod: z.object({ values: NonEmptyNumberArray }),
  outputZod: z.object({ max: FiniteNumber }),
  run({ values }) {
    return { max: Math.max(...values) };
  },
});

const calcRound = defineTool({
  name: 'calc_round',
  description:
    'Rundet `value` auf `decimals` Nachkommastellen (Round-half-up). Nutze nach jeder Berechnung, bevor du dem User eine Zahl präsentierst — insbesondere für Währungen (decimals=2) und Prozentwerte.',
  inputJsonSchema: {
    type: 'object',
    properties: {
      value: FiniteNumberJsonSchema,
      decimals: { type: 'integer', minimum: 0, maximum: 12 },
    },
    required: ['value', 'decimals'],
  },
  inputZod: z.object({
    value: FiniteNumber,
    decimals: z.number().int().min(0).max(12),
  }),
  outputZod: z.object({ rounded: FiniteNumber }),
  run({ value, decimals }) {
    const factor = Math.pow(10, decimals);
    return { rounded: Math.round(value * factor) / factor };
  },
});

const calcAggregate = defineTool({
  name: 'calc_aggregate',
  description:
    'Aggregiert eine Liste von Zahlen mit gewählter Operation: sum | avg | count | min | max. IMMER dieses Tool für Aggregate über Werte aus Tool-Ergebnissen nutzen (z.B. Summe aller Rechnungsbeträge).',
  inputJsonSchema: {
    type: 'object',
    properties: {
      values: NonEmptyNumberArrayJsonSchema,
      op: { type: 'string', enum: ['sum', 'avg', 'count', 'min', 'max'] },
    },
    required: ['values', 'op'],
  },
  inputZod: z.object({
    values: NonEmptyNumberArray,
    op: z.enum(['sum', 'avg', 'count', 'min', 'max']),
  }),
  outputZod: z.object({
    op: z.enum(['sum', 'avg', 'count', 'min', 'max']),
    result: FiniteNumber,
    count: z.number().int().min(1),
  }),
  run({ values, op }) {
    const count = values.length;
    let result: number;
    switch (op) {
      case 'sum':
        result = values.reduce((a, b) => a + b, 0);
        break;
      case 'avg':
        result = values.reduce((a, b) => a + b, 0) / count;
        break;
      case 'count':
        result = count;
        break;
      case 'min':
        result = Math.min(...values);
        break;
      case 'max':
        result = Math.max(...values);
        break;
    }
    return { op, result, count };
  },
});

// --- Export ----------------------------------------------------------------

export const calculatorTools: readonly DeterministicToolDefinition[] = [
  calcSum,
  calcSub,
  calcMul,
  calcDiv,
  calcPct,
  calcMin,
  calcMax,
  calcRound,
  calcAggregate,
];
